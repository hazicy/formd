import { test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import {
  TypoClient,
  captureSelection,
  resolveSelection,
  type NoteSession,
} from '@typo/client';
import { createTypoServer } from './server.js';
import { createMemoryNoteStore } from '../test/memory-store.js';
Object.defineProperty(globalThis, 'WebSocket', {
  value: WebSocket,
  configurable: true,
});
async function until(predicate: () => boolean) {
  const end = Date.now() + 10000;
  while (!predicate()) {
    if (Date.now() > end) throw new Error('Presence timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}
async function listen(
  instance: Awaited<ReturnType<typeof createTypoServer>>,
  port = 0,
) {
  await new Promise<void>((resolve) =>
    instance.server.listen(port, '127.0.0.1', resolve),
  );
  return (instance.server.address() as { port: number }).port;
}
test(
  'presence is document-scoped, uses stable relative cursors and removes disconnected/reconnected peers',
  { timeout: 30000 },
  async () => {
    const store = createMemoryNoteStore();
    let instance = await createTypoServer(store);
    const sessions: NoteSession[] = [];
    try {
      const port = await listen(instance);
      const api = new TypoClient(`http://127.0.0.1:${port}`);
      const note = await api.create('Presence', 'hello');
      const other = await api.create('Other', 'other');
      const a = api.connect(note.id, {
        name: 'AliceProfileUnique',
        color: '#527a56',
        client: 'vscode',
      });
      const b = api.connect(note.id, {
        name: 'Bob',
        color: '#537fba',
        client: 'web',
      });
      const c = api.connect(other.id, {
        name: 'Isolated',
        color: '#9864b0',
        client: 'web',
      });
      sessions.push(a, b, c);
      await until(
        () =>
          a.members.length === 2 &&
          b.members.length === 2 &&
          c.members.length === 1,
      );
      assert.notEqual(a.connectionId, b.connectionId);
      assert.ok(
        b.members.some(
          (member) =>
            member.id === a.connectionId &&
            member.user.name === 'AliceProfileUnique',
        ),
      );
      assert.ok(!b.members.some((member) => member.user.name === 'Isolated'));
      a.setSelection(captureSelection(a.text, 1, 3));
      await until(() =>
        b.members.some(
          (member) => member.id === a.connectionId && member.selection !== null,
        ),
      );
      assert.deepEqual(
        resolveSelection(
          b.text,
          b.members.find((member) => member.id === a.connectionId)!.selection,
        ),
        { anchor: 1, head: 3 },
      );
      b.text.insert(0, 'Z');
      await until(() => a.text.toString() === 'Zhello');
      assert.deepEqual(
        resolveSelection(
          b.text,
          b.members.find((member) => member.id === a.connectionId)!.selection,
        ),
        { anchor: 2, head: 4 },
      );
      const before = (await api.list()).find(
        (n) => n.id === note.id,
      )!.updatedAt;
      a.setUser({ ...a.user, name: 'Alice renamed' });
      a.setSelection(null);
      await until(() =>
        b.members.some(
          (member) =>
            member.user.name === 'Alice renamed' && member.selection === null,
        ),
      );
      assert.equal(
        (await api.list()).find((n) => n.id === note.id)!.updatedAt,
        before,
        'presence must not change document metadata',
      );
      a.destroy();
      await until(() => b.members.length === 1);
      assert.equal(b.members[0].id, b.connectionId);
      const oldId = b.connectionId;
      await instance.close();
      await until(
        () =>
          b.status === 'offline' &&
          b.members.length === 0 &&
          c.members.length === 0,
      );
      const stored = await store.load();
      assert.ok(stored.length > 0);
      assert.ok(
        stored.every(
          (record) => !('members' in record) && !('presence' in record),
        ),
      );
      instance = await createTypoServer(store);
      await listen(instance, port);
      await until(
        () =>
          b.status === 'connected' &&
          b.members.length === 1 &&
          c.members.length === 1,
      );
      assert.notEqual(b.connectionId, oldId);
      assert.equal(b.members[0].user.name, 'Bob');
    } finally {
      for (const session of sessions) session.destroy();
      await instance.close();
    }
  },
);
