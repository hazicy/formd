import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import {
  YEditorBinding,
  applyTextChanges,
  deltaToChanges,
  type EditorAdapter,
  type EditorChange,
  type TextChange,
} from './binding.js';
class FakeEditor implements EditorAdapter {
  text: string;
  version = 1;
  readonly listeners = new Set<(event: EditorChange) => void>();
  readonly attempts: (readonly TextChange[])[] = [];
  beforeApply?: () => Promise<void>;
  afterApply?: () => Promise<void>;
  constructor(text: string) {
    this.text = text;
  }
  snapshot() {
    return { text: this.text, version: this.version };
  }
  onChange(listener: (event: EditorChange) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  edit(changes: readonly TextChange[]) {
    this.text = applyTextChanges(this.text, changes);
    this.version++;
    const event = { ...this.snapshot(), changes };
    for (const listener of this.listeners) listener(event);
  }
  async applyEdits(changes: readonly TextChange[], version: number) {
    this.attempts.push(changes);
    await this.beforeApply?.();
    if (this.version !== version) return false;
    this.edit(changes);
    await this.afterApply?.();
    return true;
  }
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function until(predicate: () => boolean) {
  for (let n = 0; n < 100; n++) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('Timed out');
}
function fixture(initial = 'abc') {
  const doc = new Y.Doc();
  const text = doc.getText('content');
  text.insert(0, initial);
  const editor = new FakeEditor(initial);
  const errors: Error[] = [];
  const binding = new YEditorBinding(text, editor, (error) =>
    errors.push(error),
  );
  return {
    doc,
    text,
    editor,
    binding,
    errors,
    dispose() {
      binding.dispose();
      doc.destroy();
    },
  };
}
test('Y.Text deltas combine replacements without touching retained text', () => {
  assert.deepEqual(
    deltaToChanges([
      { retain: 2 },
      { delete: 2 },
      { insert: 'XYZ' },
      { retain: 3 },
      { insert: '!' },
    ]),
    [
      { rangeOffset: 2, rangeLength: 2, text: 'XYZ' },
      { rangeOffset: 7, rangeLength: 0, text: '!' },
    ],
  );
  assert.throws(
    () =>
      applyTextChanges('abc', [{ rangeOffset: 2, rangeLength: 2, text: '' }]),
    /Invalid/,
  );
});
test('local multi-cursor edits and UTF-16 offsets sync without saving; remote edits do not echo', async () => {
  const f = fixture('A😀B\nline');
  try {
    let updates = 0;
    f.doc.on('update', () => updates++);
    f.editor.edit([
      { rangeOffset: 0, rangeLength: 0, text: 'X' },
      { rangeOffset: 5, rangeLength: 4, text: 'two' },
    ]);
    assert.equal(f.text.toString(), 'XA😀B\ntwo');
    assert.equal(updates, 1);
    f.text.insert(1, 'REMOTE');
    await f.binding.flush();
    assert.equal(f.editor.text, 'XREMOTEA😀B\ntwo');
    assert.equal(updates, 2);
    assert.deepEqual(f.editor.attempts.at(-1), [
      { rangeOffset: 1, rangeLength: 0, text: 'REMOTE' },
    ]);
    assert.deepEqual(f.errors, []);
  } finally {
    f.dispose();
  }
});
test('input during an in-flight remote edit rejects stale offsets then merges both changes', async () => {
  const f = fixture();
  const gate = deferred();
  let first = true;
  f.editor.beforeApply = async () => {
    if (first) {
      first = false;
      await gate.promise;
    }
  };
  try {
    f.text.insert(0, 'R');
    await until(() => f.editor.attempts.length === 1);
    f.editor.edit([{ rangeOffset: 1, rangeLength: 0, text: 'L' }]);
    f.text.insert(f.text.length, '!');
    gate.resolve();
    await f.binding.flush();
    assert.equal(f.editor.text, 'RaLbc!');
    assert.equal(f.text.toString(), f.editor.text);
    assert.ok(f.editor.attempts.length >= 2);
    assert.deepEqual(f.errors, []);
  } finally {
    gate.resolve();
    f.dispose();
  }
});
test('input after the remote change event but before its promise resolves is retained', async () => {
  const f = fixture();
  const gate = deferred();
  let first = true;
  f.editor.afterApply = async () => {
    if (first) {
      first = false;
      await gate.promise;
    }
  };
  try {
    f.text.insert(0, 'R');
    await until(() => f.editor.text === 'Rabc');
    f.editor.edit([{ rangeOffset: 2, rangeLength: 0, text: 'L' }]);
    f.text.insert(f.text.length, '!');
    gate.resolve();
    await f.binding.flush();
    assert.equal(f.editor.text, 'RaLbc!');
    assert.equal(f.text.toString(), f.editor.text);
    assert.deepEqual(f.errors, []);
  } finally {
    gate.resolve();
    f.dispose();
  }
});
test('identical user and pending remote insertions remain two independent CRDT edits', async () => {
  const f = fixture();
  const gate = deferred();
  let first = true;
  f.editor.beforeApply = async () => {
    if (first) {
      first = false;
      await gate.promise;
    }
  };
  try {
    f.text.insert(0, 'X');
    await until(() => f.editor.attempts.length === 1);
    f.editor.edit([{ rangeOffset: 0, rangeLength: 0, text: 'X' }]);
    gate.resolve();
    await f.binding.flush();
    assert.equal(f.editor.text, 'XXabc');
    assert.equal(f.text.toString(), 'XXabc');
    assert.deepEqual(f.errors, []);
  } finally {
    gate.resolve();
    f.dispose();
  }
});
test('undo and redo only change this binding’s local edits', async () => {
  const f = fixture();
  try {
    f.editor.edit([{ rangeOffset: 3, rangeLength: 0, text: 'local' }]);
    f.binding.stopCapturing();
    f.text.insert(0, 'remote:');
    await f.binding.flush();
    await f.binding.undo();
    assert.equal(f.text.toString(), 'remote:abc');
    assert.equal(f.editor.text, 'remote:abc');
    await f.binding.redo();
    assert.equal(f.editor.text, 'remote:abclocal');
    assert.deepEqual(f.errors, []);
  } finally {
    f.dispose();
  }
});
test('changes arriving between filesystem read and document binding are applied', async () => {
  const doc = new Y.Doc();
  const text = doc.getText('content');
  text.insert(0, 'old');
  const initial = Y.encodeStateAsUpdate(doc);
  const editor = new FakeEditor('old');
  text.insert(0, 'new:');
  const errors: Error[] = [];
  const binding = new YEditorBinding(
    text,
    editor,
    (e) => errors.push(e),
    initial,
  );
  try {
    await binding.flush();
    assert.equal(editor.text, 'new:old');
    assert.deepEqual(errors, []);
  } finally {
    binding.dispose();
    doc.destroy();
  }
});
test('disposing detaches editor listeners and prevents further synchronization', async () => {
  const f = fixture();
  await f.binding.flush();
  f.binding.dispose();
  f.editor.edit([{ rangeOffset: 0, rangeLength: 0, text: 'not synced' }]);
  assert.equal(f.text.toString(), 'abc');
  assert.equal(f.editor.listeners.size, 0);
  f.doc.destroy();
});
