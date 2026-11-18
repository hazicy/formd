import express from 'express';
import cors from 'cors';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
} from 'node:fs';
import { join } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import * as Y from 'yjs';
import { fromByteArray, toByteArray } from 'base64-js';
import {
  isNoteId,
  normalizeTitle,
  MAX_CONTENT_LENGTH,
  welcomeMarkdown,
  type Note,
  validPresenceUser,
  validRelativeSelection,
  type PresenceMember,
} from '@typo/core';
interface StoredNote extends Note {
  state: string;
}
export function createTypoServer(
  dataDir: string,
  allowedOrigins = ['http://localhost:5173'],
) {
  mkdirSync(dataDir, { recursive: true });
  const file = join(dataDir, 'notes.json');
  const stored: StoredNote[] = existsSync(file)
    ? JSON.parse(readFileSync(file, 'utf8'))
    : [];
  const notes = new Map<string, Note>();
  const docs = new Map<string, Y.Doc>();
  const peers = new Map<string, Set<WebSocket>>();
  const presence = new Map<WebSocket, PresenceMember>();
  const alive = new WeakMap<WebSocket, boolean>();
  function broadcastPresence(id: string) {
    const room = peers.get(id);
    if (!room) return;
    const message = JSON.stringify({
      type: 'presence',
      members: [...room].flatMap((peer) =>
        presence.has(peer) ? [presence.get(peer)!] : [],
      ),
    });
    for (const peer of room)
      if (peer.readyState === WebSocket.OPEN) peer.send(message);
  }
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  function persist() {
    clearTimeout(flushTimer);
    const data = [...notes.values()].map((note) => ({
      ...note,
      state: fromByteArray(Y.encodeStateAsUpdate(docs.get(note.id)!)),
    }));
    writeFileSync(file + '.tmp', JSON.stringify(data), { mode: 0o600 });
    renameSync(file + '.tmp', file);
  }
  function attach(id: string, doc: Y.Doc) {
    docs.set(id, doc);
    doc.on('update', (update: Uint8Array, origin: unknown) => {
      const note = notes.get(id);
      if (!note) return;
      note.updatedAt = new Date().toISOString();
      const message = JSON.stringify({
        type: 'update',
        data: fromByteArray(update),
      });
      for (const peer of peers.get(id) || [])
        if (peer !== origin && peer.readyState === WebSocket.OPEN)
          peer.send(message);
      clearTimeout(flushTimer);
      flushTimer = setTimeout(persist, 100);
    });
  }
  for (const { state, ...note } of stored) {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, toByteArray(state));
    notes.set(note.id, note);
    attach(note.id, doc);
  }
  function add(title: string, content: string) {
    const now = new Date().toISOString();
    const note: Note = {
      id: randomUUID(),
      title: normalizeTitle(title),
      createdAt: now,
      updatedAt: now,
    };
    const doc = new Y.Doc();
    doc.getText('content').insert(0, content);
    notes.set(note.id, note);
    attach(note.id, doc);
    persist();
    return note;
  }
  if (!existsSync(file)) add('欢迎来到 Typo', welcomeMarkdown);
  const app = express();
  app.use(cors({ origin: allowedOrigins }));
  app.use(express.json({ limit: '2mb' }));
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });
  app.get('/api/notes', (_req, res) => {
    res.json(
      [...notes.values()].sort((a, b) =>
        b.updatedAt.localeCompare(a.updatedAt),
      ),
    );
  });
  app.post('/api/notes', (req, res) => {
    const { title = '未命名文档', content = '' } = req.body ?? {};
    if (
      typeof title !== 'string' ||
      typeof content !== 'string' ||
      content.length > MAX_CONTENT_LENGTH
    ) {
      res
        .status(400)
        .json({ error: '标题或正文格式错误，正文最多 100 万字符' });
      return;
    }
    res.status(201).json(add(title, content));
  });
  app.use('/api/notes/:id', (req, res, next) => {
    if (!isNoteId(req.params.id) || !notes.has(req.params.id)) {
      res.status(404).json({ error: '文档不存在' });
      return;
    }
    next();
  });
  app.patch('/api/notes/:id', (req, res) => {
    if (typeof req.body?.title !== 'string') {
      res.status(400).json({ error: '标题必须是字符串' });
      return;
    }
    const note = notes.get(req.params.id)!;
    note.title = normalizeTitle(req.body.title);
    note.updatedAt = new Date().toISOString();
    persist();
    res.json(note);
  });
  app.delete('/api/notes/:id', (req, res) => {
    const id = req.params.id;
    notes.delete(id);
    for (const peer of peers.get(id) || []) {
      peer.send(JSON.stringify({ type: 'deleted' }));
      peer.close();
    }
    peers.delete(id);
    docs.get(id)?.destroy();
    docs.delete(id);
    persist();
    res.json({ ok: true });
  });
  app.use(
    (
      error: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      console.error(error);
      res.status(500).json({ error: '服务器请求失败' });
    },
  );
  const server = createServer(app);
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 4 * 1024 * 1024,
  });
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (alive.get(ws) === false) {
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      ws.ping();
    }
  }, 15000);
  heartbeat.unref();
  server.on('upgrade', (req, socket, head) => {
    const origin = req.headers.origin;
    if (origin && !allowedOrigins.includes(origin)) {
      socket.destroy();
      return;
    }
    const id = new URL(req.url || '/', 'http://localhost').pathname.match(
      /^\/sync\/([a-zA-Z0-9_-]+)$/,
    )?.[1];
    if (!id) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const doc = docs.get(id);
      if (!doc) {
        ws.send(JSON.stringify({ type: 'deleted' }));
        ws.close();
        return;
      }
      const room = peers.get(id) || new Set<WebSocket>();
      peers.set(id, room);
      room.add(ws);
      const connectionId = randomUUID();
      alive.set(ws, true);
      ws.on('pong', () => alive.set(ws, true));
      ws.send(
        JSON.stringify({
          type: 'sync',
          selfId: connectionId,
          data: fromByteArray(Y.encodeStateAsUpdate(doc)),
        }),
      );
      ws.on('message', (raw) => {
        try {
          const message = JSON.parse(raw.toString());
          if (message.type === 'presence') {
            if (
              raw.toString().length > 4096 ||
              !validPresenceUser(message.user) ||
              !validRelativeSelection(message.selection)
            )
              throw new Error('Invalid presence');
            if (message.selection)
              for (const value of [
                message.selection.anchor,
                message.selection.head,
              ])
                Y.decodeRelativePosition(toByteArray(value));
            presence.set(ws, {
              id: connectionId,
              user: { ...message.user, name: message.user.name.trim() },
              selection: message.selection,
            });
            broadcastPresence(id);
            return;
          }
          if (message.type !== 'update' || typeof message.data !== 'string')
            throw new Error('Invalid update');
          // Validate on a temporary document before mutating the shared document.
          const update = toByteArray(message.data);
          const candidate = new Y.Doc();
          try {
            Y.applyUpdate(candidate, Y.encodeStateAsUpdate(doc));
            Y.applyUpdate(candidate, update);
            if (candidate.getText('content').length > MAX_CONTENT_LENGTH)
              throw new Error('Document too large');
          } finally {
            candidate.destroy();
          }
          Y.applyUpdate(doc, update, ws);
        } catch {
          ws.send(
            JSON.stringify({ type: 'error', message: '无效内容或文档过大' }),
          );
          ws.close(1008);
        }
      });
      ws.on('error', () => ws.close());
      ws.on('close', () => {
        room.delete(ws);
        presence.delete(ws);
        broadcastPresence(id);
        if (!room.size) peers.delete(id);
      });
    });
  });
  async function close() {
    clearInterval(heartbeat);
    clearTimeout(flushTimer);
    persist();
    for (const client of wss.clients) client.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    if (server.listening)
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    for (const doc of docs.values()) doc.destroy();
  }
  return { app, server, close };
}
