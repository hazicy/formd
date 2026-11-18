import { randomUUID } from 'node:crypto';
import { toByteArray } from 'base64-js';
import WebSocket from 'ws';
import * as Y from 'yjs';
import type { PresenceUser } from '@formd/core';

type PendingEdit = (error?: string) => void;

export class AgentSession {
  private readonly doc = new Y.Doc();
  private readonly socket: WebSocket;
  private readonly ready: Promise<void>;
  private readonly pending = new Map<string, PendingEdit>();

  constructor(url: URL, user: PresenceUser) {
    this.socket = new WebSocket(url, { handshakeTimeout: 5000 });
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Timed out opening the document.'));
        this.close();
      }, 5000);
      this.socket.on('message', (raw) => {
        try {
          const message = JSON.parse(raw.toString());
          switch (message.type) {
            case 'sync':
            case 'update':
              Y.applyUpdate(this.doc, toByteArray(message.data));
              if (message.type === 'sync') {
                this.socket.send(
                  JSON.stringify({ type: 'presence', user, selection: null }),
                );
                clearTimeout(timer);
                resolve();
              }
              break;
            case 'replaceExcerpt.result':
            case 'agent.result':
              this.pending.get(message.requestId)?.(message.error);
              break;
            case 'deleted':
            case 'error':
              reject(
                new Error(
                  message.type === 'deleted'
                    ? 'Document not found.'
                    : 'The collaboration server rejected the request.',
                ),
              );
              this.close();
              break;
          }
        } catch {
          reject(new Error('Invalid collaboration message.'));
          this.close();
        }
      });
      this.socket.on('error', (error) => reject(error));
      this.socket.once('close', () => {
        clearTimeout(timer);
        reject(new Error('Document connection closed.'));
        for (const finish of this.pending.values())
          finish(
            'Connection closed before the edit was confirmed. Read the document before retrying.',
          );
        this.doc.destroy();
      });
    });
  }

  get active() {
    return this.socket.readyState <= WebSocket.OPEN;
  }

  async read() {
    await this.ready;
    if (!this.active) throw new Error('Document connection closed.');
    return this.doc.getText('content').toString();
  }

  async edit(expected: string, replacement: string, previewMs = 300) {
    const previewId =
      expected && expected !== replacement && previewMs > 0
        ? await this.request({ type: 'previewExcerpt', expected })
        : undefined;
    if (previewId)
      await new Promise<void>((resolve) => setTimeout(resolve, previewMs));
    await this.request({
      type: 'replaceExcerpt',
      expected,
      replacement,
      previewId,
    });
  }

  private async request(operation: Record<string, unknown>) {
    await this.ready;
    if (!this.active) throw new Error('Document connection closed.');
    const requestId = randomUUID();
    await new Promise<void>((resolve, reject) => {
      const finish: PendingEdit = (error) => {
        clearTimeout(timer);
        this.pending.delete(requestId);
        if (error) reject(new Error(error));
        else resolve();
      };
      const timer = setTimeout(
        () =>
          finish(
            'Edit confirmation timed out. Read the latest document before retrying.',
          ),
        5000,
      );
      this.pending.set(requestId, finish);
      this.socket.send(JSON.stringify({ ...operation, requestId }), (error) => {
        if (error) finish(error.message);
      });
    });
    return requestId;
  }

  close() {
    this.socket.close();
  }
}
