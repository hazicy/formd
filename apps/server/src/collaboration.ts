import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import * as Y from 'yjs';
import { fromByteArray, toByteArray } from 'base64-js';
import { captureSelection, resolveSelection } from '@formd/client';
import {
  MAX_CONTENT_LENGTH,
  validPresenceUser,
  validRelativeSelection,
  type PresenceMember,
} from '@formd/core';

export function createCollaboration() {
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
  function bind(
    server: Server,
    getDoc: (id: string) => Y.Doc | undefined,
    allowedOrigins: string[],
  ) {
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
        const doc = getDoc(id);
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
        let previewTimer: ReturnType<typeof setTimeout> | undefined;
        let flashTimer: ReturnType<typeof setTimeout> | undefined;
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
            if (message.type === 'agent.edit') {
              const { requestId, expected, replacement } = message;
              const member = presence.get(ws);
              if (
                typeof requestId !== 'string' ||
                requestId.length > 80 ||
                typeof expected !== 'string' ||
                typeof replacement !== 'string' ||
                member?.user.client !== 'agent'
              )
                throw new Error('Invalid agent edit');
              const reply = (error?: string) =>
                ws.send(
                  JSON.stringify({ type: 'agent.result', requestId, error }),
                );
              if (previewTimer) {
                reply('An edit is already being previewed.');
                return;
              }
              const text = doc.getText('content');
              const findStart = () => {
                const current = text.toString();
                if (!expected) return current ? -1 : 0;
                const offset = current.indexOf(expected);
                return offset >= 0 &&
                  current.indexOf(expected, offset + 1) === -1
                  ? offset
                  : -1;
              };
              const conflict =
                'The original text is missing or ambiguous. Read the latest document and use a unique excerpt.';
              const start = findStart();
              if (start < 0) {
                reply(conflict);
                return;
              }
              if (expected === replacement) {
                reply();
                return;
              }

              clearTimeout(flashTimer);
              delete member.agentFlash;
              const preview = captureSelection(
                text,
                start,
                start + expected.length,
              );
              member.selection = preview;
              broadcastPresence(id);
              previewTimer = setTimeout(
                () => {
                  previewTimer = undefined;
                  if (ws.readyState !== WebSocket.OPEN || getDoc(id) !== doc)
                    return;
                  const range = resolveSelection(text, preview);
                  const offset = findStart();
                  if (
                    !range ||
                    offset < 0 ||
                    range.anchor !== offset ||
                    range.head !== offset + expected.length
                  ) {
                    member.selection = null;
                    broadcastPresence(id);
                    reply(conflict);
                    return;
                  }
                  if (
                    text.length - expected.length + replacement.length >
                    MAX_CONTENT_LENGTH
                  ) {
                    member.selection = null;
                    broadcastPresence(id);
                    reply('The edit would exceed the document size limit.');
                    return;
                  }
                  doc.transact(() => {
                    text.delete(offset, expected.length);
                    text.insert(offset, replacement);
                  });
                  const caret = offset + replacement.length;
                  member.selection = captureSelection(text, caret, caret);
                  if (replacement) {
                    member.agentFlash = {
                      id: randomUUID(),
                      range: captureSelection(text, offset, caret),
                    };
                    flashTimer = setTimeout(() => {
                      delete member.agentFlash;
                      broadcastPresence(id);
                    }, 400);
                  }
                  broadcastPresence(id);
                  reply();
                },
                expected ? 300 : 0,
              );
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
          clearTimeout(previewTimer);
          clearTimeout(flashTimer);
          room.delete(ws);
          presence.delete(ws);
          broadcastPresence(id);
          if (!room.size) peers.delete(id);
        });
      });
    });
  }
  return {
    bind,
    onUpdate(id: string, update: Uint8Array, origin: unknown) {
      const message = JSON.stringify({
        type: 'update',
        data: fromByteArray(update),
      });
      for (const peer of peers.get(id) || [])
        if (peer !== origin && peer.readyState === WebSocket.OPEN)
          peer.send(message);
    },
    onDelete(id: string) {
      for (const peer of peers.get(id) || []) {
        peer.send(JSON.stringify({ type: 'deleted' }));
        peer.close();
      }
      peers.delete(id);
    },
    close() {
      clearInterval(heartbeat);
      for (const client of wss.clients) client.terminate();
      return new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}
