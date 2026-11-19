import { test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { once } from 'node:events';
import * as Y from 'yjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import {
  FormdClient,
  captureCommentAnchor,
  resolveSelection,
  type NoteSession,
} from '@formd/client';
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

test('deleting a folder preserves its notes and nested folders', async () => {
  const store = createMemoryNoteStore();
  const instance = await createFormdServer(store);
  try {
    const client = new FormdClient(`http://127.0.0.1:${await listen(instance)}`);
    const parent = await client.createFolder('上级');
    const removed = await client.createFolder('待删除', parent.id);
    const existing = await client.createFolder('资料', parent.id);
    const child = await client.createFolder('资料', removed.id);
    const sameName = await client.createFolder(removed.name, removed.id);
    const nested = await client.createFolder('子目录', child.id);
    const note = await client.create('原文', '# Markdown', removed.id);
    const nestedNote = await client.create('子目录文档', '', nested.id);

    assert.equal((await client.deleteFolder(removed.id)).parentId, parent.id);
    const folders = new Map((await client.listFolders()).map((entry) => [entry.id, entry]));
    assert.equal(folders.has(removed.id), false);
    assert.equal(folders.get(existing.id)?.name, '资料');
    assert.equal(folders.get(child.id)?.name, '资料 (2)');
    assert.equal(folders.get(child.id)?.parentId, parent.id);
    assert.equal(folders.get(sameName.id)?.name, '待删除 (2)');
    assert.equal(folders.get(sameName.id)?.parentId, parent.id);
    assert.equal(folders.get(nested.id)?.parentId, child.id);
    const notes = new Map((await client.list()).map((entry) => [entry.id, entry]));
    assert.equal(notes.get(note.id)?.folderId, parent.id);
    assert.equal(notes.get(nestedNote.id)?.folderId, nested.id);
    assert.equal((await store.load()).find((entry) => entry.id === note.id)?.folderId, parent.id);
    await client.rename(note.id, '仍可编辑');
  } finally {
    await instance.close();
  }
});

test('sync confirms only persisted updates and retries failed saves', async () => {
  const store = createMemoryNoteStore();
  const upsert = store.upsert;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let blocked = false;
  let writes = 0;
  let fail = false;
  store.upsert = async (note) => {
    writes++;
    if (blocked) await gate;
    if (fail) {
      fail = false;
      throw new Error('Storage unavailable');
    }
    await upsert(note);
  };
  const instance = await createFormdServer(store);
  let session: NoteSession | undefined;
  try {
    const port = await listen(instance);
    const client = new FormdClient(`http://127.0.0.1:${port}`);
    const note = await client.create('Persistence', 'start');
    session = client.connect(note.id);
    const editor = session;
    await until(
      () => editor.persistenceStatus === 'saved',
      'Initial sync was not confirmed',
    );

    blocked = true;
    const before = writes;
    editor.replace('first');
    await until(() => writes > before, 'First write did not start');
    assert.equal(editor.persistenceStatus, 'saving');
    editor.replace('latest');
    assert.equal(editor.persistenceStatus, 'saving');
    release();
    await until(
      () => editor.persistenceStatus === 'saved',
      'Latest write was not confirmed',
    );

    fail = true;
    editor.replace('retry this edit');
    await until(
      () => editor.persistenceStatus === 'failed',
      'Write failure was not reported',
    );
    assert.equal(editor.status, 'connected');
    editor.retryPersistence();
    await until(
      () => editor.persistenceStatus === 'saved',
      'Retry was not confirmed',
    );
  } finally {
    release();
    session?.destroy();
    await instance.close();
  }
});

test('save batches acknowledge only the newest sequence per connection', async () => {
  const store = createMemoryNoteStore();
  const upsert = store.upsert;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let writing = false;
  let block = false;
  store.upsert = async (note) => {
    if (block) {
      writing = true;
      await gate;
    }
    await upsert(note);
  };
  const instance = await createFormdServer(store);
  const source = new Y.Doc();
  const text = source.getText('content');
  let socket: WebSocket | undefined;
  let observer: NoteSession | undefined;
  try {
    const port = await listen(instance);
    const client = new FormdClient(`http://127.0.0.1:${port}`);
    const note = await client.create('Batch', '');
    const peer = client.connect(note.id);
    observer = peer;
    await until(
      () => peer.persistenceStatus === 'saved',
      'Observer did not connect',
    );

    const sender = new WebSocket(`ws://127.0.0.1:${port}/sync/${note.id}`);
    socket = sender;
    const acknowledgements: number[] = [];
    sender.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === 'saved') acknowledgements.push(message.sequence);
    });
    await once(sender, 'open');
    let sequence = 0;
    source.on('update', (update) => {
      sender.send(
        JSON.stringify({
          type: 'update',
          sequence: ++sequence,
          data: Buffer.from(update).toString('base64'),
        }),
      );
    });

    block = true;
    text.insert(0, 'a');
    await until(() => writing, 'First batch did not start writing');
    text.insert(1, 'b');
    text.insert(2, 'c');
    await until(
      () => peer.text.toString() === 'abc',
      'Server did not receive the queued batch',
    );
    assert.equal(acknowledgements.length, 0);
    release();
    await until(
      () => acknowledgements.includes(3),
      'Second batch was not acknowledged',
    );
    assert.deepEqual(acknowledgements, [1, 3]);
  } finally {
    release();
    socket?.terminate();
    observer?.destroy();
    source.destroy();
    await instance.close();
  }
});

test('anchored comments and concurrent replies survive server restart', async () => {
  const store = createMemoryNoteStore();
  const server = await createFormdServer(store);
  let restarted: typeof server | undefined;
  const sessions: NoteSession[] = [];
  try {
    const port = await listen(server);
    const client = new FormdClient(`http://127.0.0.1:${port}`);
    const note = await client.create('Review', 'paragraph');
    const first = client.connect(note.id);
    const second = client.connect(note.id);
    sessions.push(first, second);
    await until(
      () => first.status === 'connected' && second.status === 'connected',
      'Editors did not connect',
    );
    const id = first.comments.create(
      captureCommentAnchor(first.text, 0, 9),
      'First comment',
    );
    await until(
      () => second.comments.list().length === 1,
      'Comment did not synchronize',
    );
    first.comments.reply(id, 'First reply');
    second.comments.reply(id, 'Second reply');
    second.text.insert(0, 'Prefix ');
    await until(
      () =>
        first.comments.list()[0].messages.length === 3 &&
        first.text.toString() === 'Prefix paragraph',
      'Concurrent edits did not merge',
    );
    first.comments.setResolved(id, true);
    await until(
      () => first.persistenceStatus === 'saved',
      'Comment changes were not persisted',
    );
    await server.close();

    restarted = await createFormdServer(store);
    const nextPort = await listen(restarted);
    const reopened = new FormdClient(`http://127.0.0.1:${nextPort}`).connect(
      note.id,
    );
    sessions.push(reopened);
    await until(
      () => reopened.status === 'connected',
      'Reopened editor did not connect',
    );
    const [thread] = reopened.comments.list();
    assert.equal(thread.resolved, true);
    assert.deepEqual(
      new Set(thread.messages.map((message) => message.body)),
      new Set(['First comment', 'First reply', 'Second reply']),
    );
    assert.deepEqual(resolveSelection(reopened.text, thread.anchor), {
      anchor: 7,
      head: 16,
    });
  } finally {
    for (const session of sessions) session.destroy();
    await restarted?.close();
    await server.close();
  }
});

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

test('MCP edits the live document without overwriting human changes', async () => {
  const instance = await createFormdServer(createMemoryNoteStore());
  const port = await listen(instance);
  const apiUrl = `http://127.0.0.1:${port}`;
  const client = new FormdClient(apiUrl);
  const mcp = new Client({ name: 'test', version: '1' });
  let human: NoteSession | undefined;
  try {
    const note = await client.create(
      'Agent editing',
      'Old sentence.\nHuman draft.',
    );
    human = client.connect(note.id);
    const live = human;
    await until(() => live.status === 'connected', 'Editor did not connect');
    await mcp.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [
          '--import',
          'tsx',
          fileURLToPath(new URL('./mcp.ts', import.meta.url)),
        ],
        env: { FORMD_API_URL: apiUrl, FORMD_AGENT_NAME: 'Draft Agent' },
      }),
    );
    const listed = await mcp.callTool({
      name: 'list_documents',
      arguments: { query: 'agent editing' },
    });
    assert.deepEqual(listed.structuredContent, { documents: [note] });
    const read = await mcp.callTool({
      name: 'read_document',
      arguments: { id: note.id },
    });
    assert.deepEqual(read.structuredContent, {
      id: note.id,
      markdown: 'Old sentence.\nHuman draft.',
    });
    await until(
      () =>
        live.members.some(
          (member) =>
            member.user.name === 'Draft Agent' &&
            member.user.client === 'agent',
        ),
      'Agent did not appear in the online members',
    );

    let previewSeen = false;
    let flashSeen = false;
    const stopWatching = live.subscribePresence(() => {
      const agent = live.members.find(
        (member) => member.user.client === 'agent',
      );
      if (!agent) return;
      const preview = resolveSelection(live.text, agent.selection);
      const content = live.text.toString();
      previewSeen ||=
        !!preview &&
        content.slice(preview.anchor, preview.head) === 'Old sentence.';
    });
    const stopFlashes = live.subscribeExcerptReplaced((event) => {
      const flash = resolveSelection(live.text, event.range);
      flashSeen ||=
        !!flash &&
        live.text.toString().slice(flash.anchor, flash.head) ===
          'New sentence.';
    });
    const edit = mcp.callTool({
      name: 'edit_document',
      arguments: {
        id: note.id,
        expected: 'Old sentence.',
        replacement: 'New sentence.',
        preview_ms: 750,
      },
    });
    await until(() => previewSeen, 'Original excerpt was not previewed');
    live.replace('Old sentence.\nHuman draft, updated.');
    assert.equal((await edit).isError, undefined);
    await until(
      () => live.text.toString() === 'New sentence.\nHuman draft, updated.',
      'Agent or human edit was lost',
    );
    await until(() => {
      const agent = live.members.find(
        (member) => member.user.client === 'agent',
      );
      const selection = agent && resolveSelection(live.text, agent.selection);
      const caret = 'New sentence.'.length;
      return selection?.anchor === caret && selection.head === caret;
    }, 'Agent cursor did not collapse at the end of the replacement');
    await until(() => flashSeen, 'Replacement event did not reach the editor');
    stopWatching();
    stopFlashes();
    assert.ok(
      previewSeen,
      'Agent did not select the original text before editing',
    );
    assert.ok(flashSeen, 'Agent did not publish the replacement highlight');
    const conflict = mcp.callTool({
      name: 'edit_document',
      arguments: {
        id: note.id,
        expected: 'New sentence.',
        replacement: 'Do not apply.',
        preview_ms: 750,
      },
    });
    await until(() => {
      const agent = live.members.find(
        (member) => member.user.client === 'agent',
      );
      const range = agent && resolveSelection(live.text, agent.selection);
      return range?.anchor === 0 && range.head === 'New sentence.'.length;
    }, 'Second excerpt was not previewed');
    live.replace('Human sentence.\nHuman draft, updated.');
    assert.equal((await conflict).isError, true);
    assert.equal(
      live.text.toString(),
      'Human sentence.\nHuman draft, updated.',
    );
    const immediate = await mcp.callTool({
      name: 'edit_document',
      arguments: {
        id: note.id,
        expected: 'Human sentence.',
        replacement: 'Final sentence.',
        preview_ms: 0,
      },
    });
    assert.equal(immediate.isError, undefined);
    await until(
      () => live.text.toString() === 'Final sentence.\nHuman draft, updated.',
      'Immediate edit was lost',
    );
    await mcp.callTool({ name: 'close_document', arguments: { id: note.id } });
    await until(
      () => !live.members.some((member) => member.user.client === 'agent'),
      'Agent did not leave',
    );
  } finally {
    human?.destroy();
    await mcp.close();
    await instance.close();
  }
});
