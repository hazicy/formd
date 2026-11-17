import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTitle, isNoteId, markdownFilename } from './index.js';
test('titles are normalized and filenames cannot escape the export name', () => {
  assert.equal(normalizeTitle('   '), '未命名文档');
  assert.equal(normalizeTitle('  hello  '), 'hello');
  assert.equal(normalizeTitle('x'.repeat(200)).length, 160);
  assert.equal(markdownFilename('a/b:c'), 'a-b-c.md');
});
test('document ids exclude traversal and URL separators', () => {
  for (const id of ['../a', 'a/b', '', 'a?x', 'a'.repeat(81)])
    assert.equal(isNoteId(id), false);
  assert.equal(isNoteId('a_1-abc'), true);
});
