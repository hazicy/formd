import { test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { FormdClient, resolveSelection, type NoteSession } from '@formd/client';
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

    live.replace('Old sentence.\nHuman draft, updated.');
    let previewSeen = false;
    let flashSeen = false;
    const stopWatching = live.subscribePresence(() => {
      const agent = live.members.find(
        (member) => member.user.client === 'agent',
      );
      if (!agent) return;
      const preview = resolveSelection(live.text, agent.selection);
      const flash = resolveSelection(
        live.text,
        agent.agentFlash?.range ?? null,
      );
      const content = live.text.toString();
      previewSeen ||=
        !!preview &&
        content.slice(preview.anchor, preview.head) === 'Old sentence.';
      flashSeen ||=
        !!flash && content.slice(flash.anchor, flash.head) === 'New sentence.';
    });
    const edited = await mcp.callTool({
      name: 'edit_document',
      arguments: {
        id: note.id,
        expected: 'Old sentence.',
        replacement: 'New sentence.',
      },
    });
    assert.equal(edited.isError, undefined);
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
    stopWatching();
    assert.ok(
      previewSeen,
      'Agent did not select the original text before editing',
    );
    assert.ok(flashSeen, 'Agent did not publish the replacement highlight');
    const conflict = await mcp.callTool({
      name: 'edit_document',
      arguments: {
        id: note.id,
        expected: 'Old sentence.',
        replacement: 'Do not apply.',
      },
    });
    assert.equal(conflict.isError, true);
    assert.equal(live.text.toString(), 'New sentence.\nHuman draft, updated.');
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
