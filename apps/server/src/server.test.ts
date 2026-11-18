import { test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { FormdClient, type NoteSession } from '@formd/client';
import { createFormdServer } from './server.js';
import { createMemoryNoteStore } from '../test/memory-store.js';
Object.defineProperty(globalThis, 'WebSocket', {
  value: WebSocket,
  configurable: true,
});
async function until(
  predicate: () => boolean | Promise<boolean>,
  message: string,
) {
  const deadline = Date.now() + 10000;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
async function listen(
  instance: Awaited<ReturnType<typeof createFormdServer>>,
  port = 0,
) {
  await new Promise<void>((resolve) =>
    instance.server.listen(port, '127.0.0.1', resolve),
  );
  return (instance.server.address() as { port: number }).port;
}
test('HTTP API handles preflight, malformed JSON, and oversized bodies', async () => {
  const store = createMemoryNoteStore();
  const origin = 'http://localhost:5173';
  const instance = await createFormdServer(store, [origin]);
  try {
    const port = await listen(instance);
    const url = `http://127.0.0.1:${port}/api/notes`;
    const preflight = await fetch(url, {
      method: 'OPTIONS',
      headers: {
        Origin: origin,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type',
      },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), origin);
    assert.equal(
      preflight.headers.get('access-control-allow-headers'),
      'content-type',
    );

    const malformed = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{',
    });
    assert.equal(malformed.status, 400);
    assert.equal(typeof (await malformed.json()).error, 'string');

    const oversized = await instance.app.request('/api/notes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'x'.repeat(2 * 1024 * 1024) }),
    });
    assert.equal(oversized.status, 413);
    assert.equal(typeof (await oversized.json()).error, 'string');
  } finally {
    await instance.close();
  }
});
test(
  'CRUD, concurrent edits, reconnect, durable recovery and deletion',
  { timeout: 30000 },
  async () => {
    const store = createMemoryNoteStore();
    let instance = await createFormdServer(store);
    const sessions: NoteSession[] = [];
    try {
      const port = await listen(instance);
      const api = new FormdClient(`http://127.0.0.1:${port}`);
      assert.equal((await api.list()).length, 0);
      const note = await api.create('  Team  ', 'Start');
      assert.equal(note.title, 'Team');
      assert.equal((await api.rename(note.id, ' Notes ')).title, 'Notes');
      const a = api.connect(note.id),
        b = api.connect(note.id);
      sessions.push(a, b);
      await until(
        () => a.status === 'connected' && b.status === 'connected',
        'clients did not connect',
      );
      assert.equal(a.text.toString(), 'Start');
      a.text.insert(0, 'A');
      b.text.insert(0, 'B');
      await until(
        () => a.text.toString() === b.text.toString() && a.text.length === 7,
        'concurrent inserts did not converge',
      );
      assert.match(a.text.toString(), /A/);
      assert.match(a.text.toString(), /B/);
      const online = a.text.toString();
      await instance.close();
      await until(
        () => a.status === 'offline' && b.status === 'offline',
        'clients did not detect offline',
      );
      a.replace(a.text.toString() + ' offline');
      instance = await createFormdServer(store);
      await listen(instance, port);
      await until(
        () =>
          a.status === 'connected' && b.text.toString() === online + ' offline',
        'reconnect did not merge offline edits',
      );
      await instance.close();
      instance = await createFormdServer(store);
      await listen(instance, port);
      const c = api.connect(note.id);
      sessions.push(c);
      await until(
        () => c.status === 'connected',
        'durable client did not connect',
      );
      assert.equal(c.text.toString(), online + ' offline');
      await api.delete(note.id);
      await until(() => c.status === 'deleted', 'deletion was not propagated');
      assert.equal(
        (await api.list()).some((n) => n.id === note.id),
        false,
      );
      await assert.rejects(() => api.rename(note.id, 'gone'), /文档不存在/);
      const invalid = await fetch(`http://127.0.0.1:${port}/api/notes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 123 }),
      });
      assert.equal(invalid.status, 400);
      for (const n of await api.list()) await api.delete(n.id);
      await instance.close();
      instance = await createFormdServer(store);
      await listen(instance, port);
      await until(async () => {
        try {
          return (await api.list()).length === 0;
        } catch {
          return false;
        }
      }, 'empty workspace was not preserved');
    } finally {
      for (const session of sessions) session.destroy();
      await instance.close();
    }
  },
);
