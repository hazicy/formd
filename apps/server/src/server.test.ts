import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { TypoClient, type NoteSession } from '@typo/client';
import { createTypoServer } from './server.js';
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
async function listen(instance: ReturnType<typeof createTypoServer>, port = 0) {
  await new Promise<void>((resolve) =>
    instance.server.listen(port, '127.0.0.1', resolve),
  );
  return (instance.server.address() as { port: number }).port;
}
test(
  'CRUD, concurrent edits, reconnect, durable recovery and deletion',
  { timeout: 30000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'typo-test-'));
    let instance = createTypoServer(dir);
    const sessions: NoteSession[] = [];
    try {
      const port = await listen(instance);
      const api = new TypoClient(`http://127.0.0.1:${port}`);
      assert.equal((await api.list()).length, 1);
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
      instance = createTypoServer(dir);
      await listen(instance, port);
      await until(
        () =>
          a.status === 'connected' && b.text.toString() === online + ' offline',
        'reconnect did not merge offline edits',
      );
      await instance.close();
      instance = createTypoServer(dir);
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
      instance = createTypoServer(dir);
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
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
