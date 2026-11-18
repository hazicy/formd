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
    confirmPersistence: (
      id: string,
      connection: object,
      reply: (saved: boolean) => void,
    ) => void,
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
        let pendingPreview:
          | {
              id: string;
              expected: string;
              range: ReturnType<typeof captureSelection>;
            }
          | undefined;
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
            if (
              message.type === 'previewExcerpt' ||
              message.type === 'replaceExcerpt' ||
              message.type === 'agent.edit'
            ) {
              const { requestId, expected, replacement, previewId } = message;
              const previewOnly = message.type === 'previewExcerpt';
              const member = presence.get(ws);
              if (
                typeof requestId !== 'string' ||
                requestId.length > 80 ||
                typeof expected !== 'string' ||
                (!previewOnly && typeof replacement !== 'string') ||
                !member
              )
                throw new Error('Invalid excerpt replacement');
              const reply = (error?: string) =>
                ws.send(
                  JSON.stringify({
                    type:
                      message.type === 'agent.edit'
                        ? 'agent.result'
                        : 'replaceExcerpt.result',
                    requestId,
                    error,
                  }),
                );
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
              if (previewOnly) {
                pendingPreview = undefined;
                member.selection = null;
                if (start >= 0) {
                  const range = captureSelection(
                    text,
                    start,
                    start + expected.length,
                  );
                  pendingPreview = { id: requestId, expected, range };
                  member.selection = range;
                }
                broadcastPresence(id);
                reply(start < 0 ? conflict : undefined);
                return;
              }
              if (previewId !== undefined && pendingPreview?.id !== previewId) {
                reply(conflict);
                return;
              }
              const preview =
                previewId === undefined ? undefined : pendingPreview;
              if (pendingPreview) member.selection = null;
              pendingPreview = undefined;
              const range = preview && resolveSelection(text, preview.range);
              if (
                start < 0 ||
                (preview &&
                  (preview.expected !== expected ||
                    !range ||
                    range.anchor !== start ||
                    range.head !== start + expected.length))
              ) {
                broadcastPresence(id);
                reply(conflict);
                return;
              }
              if (
                text.length - expected.length + replacement.length >
                MAX_CONTENT_LENGTH
              ) {
                broadcastPresence(id);
                reply('The edit would exceed the document size limit.');
                return;
              }
              if (expected !== replacement) {
                doc.transact(() => {
                  text.delete(start, expected.length);
                  text.insert(start, replacement);
                });
              }
              const caret = start + replacement.length;
              member.selection = captureSelection(text, caret, caret);
              broadcastPresence(id);
              if (replacement && expected !== replacement) {
                const event = JSON.stringify({
                  type: 'excerpt.replaced',
                  id: randomUUID(),
                  memberId: member.id,
                  range: captureSelection(text, start, caret),
                });
                for (const peer of room)
                  if (peer.readyState === WebSocket.OPEN) peer.send(event);
              }
              reply();
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
            const { sequence } = message;
            if (
              sequence !== undefined &&
              (!Number.isSafeInteger(sequence) || sequence < 1)
            )
              throw new Error('Invalid update sequence');
            Y.applyUpdate(doc, update, ws);
            if (sequence !== undefined) {
              confirmPersistence(id, ws, (saved) => {
                if (ws.readyState !== WebSocket.OPEN) return;
                ws.send(
                  JSON.stringify({
                    type: saved ? 'saved' : 'saveFailed',
                    sequence,
                  }),
                );
              });
            }
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
