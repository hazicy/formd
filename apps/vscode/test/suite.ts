import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import type { Note } from '@typo/core';
import type { NotesView } from '../src/notes-view.js';
import type { PresenceController } from '../src/presence.js';
async function until(
  predicate: () => boolean | Promise<boolean>,
  message: string,
) {
  const end = Date.now() + 15000;
  while (!(await predicate())) {
    if (Date.now() > end) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
export async function run() {
  const apiUrl = process.env.TYPO_TEST_API_URL!;
  const config = vscode.workspace.getConfiguration('typo');
  await config.update('serverUrl', apiUrl, vscode.ConfigurationTarget.Global);
  await config.update(
    'displayName',
    'VS Alice',
    vscode.ConfigurationTarget.Global,
  );
  const extension = vscode.extensions.getExtension<{
    notes: NotesView;
    presence: PresenceController;
  }>('typo-local.typo-vscode');
  assert.ok(extension);
  const api = await extension.activate();
  async function request<T>(
    path: string,
    method = 'GET',
    data?: unknown,
  ): Promise<T> {
    const response = await fetch(apiUrl + path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    if (!response.ok) throw new Error(`Fixture API failed: ${response.status}`);
    return response.json() as Promise<T>;
  }
  const client = {
    create: (title: string, content: string) =>
      request<Note>('/api/notes', 'POST', { title, content }),
    rename: (id: string, title: string) =>
      request<Note>(`/api/notes/${id}`, 'PATCH', { title }),
    delete: (id: string) => request(`/api/notes/${id}`, 'DELETE'),
  };
  const note = await client.create('VS Code ↔ Web', 'start\nsecond');
  const browser = await chromium.launch({
    channel: process.env.PLAYWRIGHT_CHANNEL || undefined,
    headless: true,
  });
  try {
    await vscode.commands.executeCommand('workbench.view.extension.typo');
    await vscode.commands.executeCommand('typo.refreshNotes');
    await until(
      () => api.notes.getChildren().some((n) => n.id === note.id),
      'Sidebar did not load the fixture note',
    );
    const item = api.notes.getTreeItem(note);
    assert.equal(item.contextValue, 'typoNote');
    assert.equal(item.command?.command, 'typo.openNote');
    console.log('PASS Formd sidebar view and note item command');
    const uri = await vscode.commands.executeCommand<vscode.Uri>(
      'typo.openNote',
      note,
    );
    assert.ok(uri);
    const document = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(document);
    const page = await browser.newPage();
    await page.addInitScript(() =>
      localStorage.setItem(
        'typo.profile',
        JSON.stringify({ name: 'Web Bob', color: '#b45e46', client: 'web' }),
      ),
    );
    await page.goto(`${process.env.TYPO_TEST_WEB_URL}/#${note.id}`);
    const webEditor = page.getByRole('textbox', { name: 'Markdown 编辑器' });
    await webEditor.waitFor();
    await until(() => webEditor.isEnabled(), 'Web editor not enabled');
    const edited = await editor.edit((edit) =>
      edit.insert(new vscode.Position(0, 0), 'VSCODE:'),
    );
    assert.ok(edited);
    assert.ok(document.isDirty, 'This must sync an unsaved edit');
    await until(
      async () => (await webEditor.inputValue()) === 'VSCODE:start\nsecond',
      'Unsaved VS Code edit did not reach the actual Web editor',
    );
    console.log('PASS unsaved VS Code typing reaches the actual Web editor');
    // Both editors make changes from the same base before receiving the other side.
    await Promise.all([
      editor.edit((edit) =>
        edit.insert(
          document.positionAt(document.getText().length),
          '\nlocal 😀',
        ),
      ),
      webEditor.evaluate((element) => {
        const input = element as HTMLTextAreaElement;
        const setter = Object.getOwnPropertyDescriptor(
          HTMLTextAreaElement.prototype,
          'value',
        )!.set!;
        setter.call(input, 'WEB:' + input.value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }),
    ]);
    await until(
      async () =>
        document.getText() === (await webEditor.inputValue()) &&
        document.getText().includes('local 😀') &&
        document.getText().startsWith('WEB:'),
      'Concurrent Web/VS Code edits did not converge',
    ).catch(async (error) => {
      console.error(
        'Editor snapshots:',
        JSON.stringify({
          vscode: document.getText(),
          web: await webEditor.inputValue(),
        }),
      );
      throw error;
    });
    console.log('PASS simultaneous Web and VS Code edits converge');
    await until(
      () =>
        api.presence
          .getChildren()
          .some((member) => member.user.name === 'Web Bob'),
      'VS Code member sidebar did not list Web peer',
    );
    await page.getByRole('button', { name: /在线成员 2 人/ }).click();
    await page
      .getByRole('region', { name: '在线成员列表' })
      .getByText('VS Alice', { exact: false })
      .waitFor();
    await page.getByRole('button', { name: '关闭在线成员' }).click();
    const selectionStart = document.positionAt(2),
      selectionEnd = document.positionAt(7);
    editor.selection = new vscode.Selection(selectionStart, selectionEnd);
    await page.getByRole('img', { name: /VS Alice 的光标/ }).waitFor();
    await webEditor.focus();
    await webEditor.evaluate((element) =>
      (element as HTMLTextAreaElement).setSelectionRange(1, 1),
    );
    await webEditor.press('Shift+ArrowRight');
    await webEditor.press('Shift+ArrowRight');
    await webEditor.press('Shift+ArrowRight');
    await webEditor.press('Shift+ArrowRight');
    await until(
      () =>
        api.presence
          .getChildren()
          .some(
            (member) =>
              member.user.name === 'Web Bob' &&
              api.presence.location(member.id)?.head.character === 5,
          ),
      'Web cursor did not appear in VS Code',
    ).catch((error) => {
      console.error(
        'Presence snapshot',
        JSON.stringify(
          api.presence.getChildren().map((member) => ({
            member,
            location: api.presence.location(member.id)?.head,
          })),
        ),
      );
      throw error;
    });
    const bob = api.presence
      .getChildren()
      .find((member) => member.user.name === 'Web Bob')!;
    await vscode.commands.executeCommand('typo.followMember', bob);
    assert.equal(api.presence.followingId, bob.id);
    await vscode.commands.executeCommand('typo.stopFollowing');
    assert.equal(api.presence.followingId, undefined);
    await editor.edit((edit) => edit.insert(new vscode.Position(0, 0), 'XY'));
    await until(
      () => api.presence.location(bob.id)?.head.character === 7,
      'Relative cursor did not track concurrent insertion',
    );
    await until(
      async () =>
        webEditor.evaluate((element) => {
          const input = element as HTMLTextAreaElement;
          return input.selectionStart === 3 && input.selectionEnd === 7;
        }),
      'Web selection was not preserved through remote insertion',
    );
    console.log(
      'PASS cross-platform online members, remote selections and follow/stop',
    );

    // Exercise edits with multiple disjoint ranges in one VS Code transaction.
    const before = document.getText();
    await editor.edit((edit) => {
      edit.insert(document.positionAt(0), '①');
      edit.insert(document.positionAt(before.length), '②');
    });
    await until(
      async () => (await webEditor.inputValue()) === document.getText(),
      'Multi-cursor edit did not sync',
    );
    await document.save();
    await webEditor.fill('REMOTE\n' + (await webEditor.inputValue()));
    await until(
      () => document.getText().startsWith('REMOTE\n'),
      'Remote update did not change saved editor',
    );
    // The native editor maps a caret through incremental edits before it.
    editor.selection = new vscode.Selection(
      document.positionAt(document.getText().length),
      document.positionAt(document.getText().length),
    );
    const oldOffset = document.offsetAt(editor.selection.active);
    await webEditor.fill('prefix:' + (await webEditor.inputValue()));
    await until(
      () => document.getText().startsWith('prefix:'),
      'Remote prefix did not sync',
    );
    await until(
      () => document.offsetAt(editor.selection.active) === oldOffset + 7,
      'Caret did not track remote prefix',
    );
    console.log('PASS multi-range edits, save and remote caret mapping');
    const remotePrefix = document.getText().slice(0, 14);
    await editor.edit((edit) =>
      edit.insert(document.positionAt(document.getText().length), 'OWN_UNDO'),
    );
    await until(
      async () => (await webEditor.inputValue()).endsWith('OWN_UNDO'),
      'Local undo test edit not synced',
    );
    await vscode.commands.executeCommand('typo.undo');
    await until(
      async () =>
        !document.getText().includes('OWN_UNDO') &&
        (await webEditor.inputValue()) === document.getText(),
      'Local CRDT undo failed',
    );
    assert.equal(
      document.getText().slice(0, 14),
      remotePrefix,
      'Undo must keep remote edits',
    );
    await vscode.commands.executeCommand('typo.redo');
    await until(
      async () =>
        document.getText().endsWith('OWN_UNDO') &&
        (await webEditor.inputValue()) === document.getText(),
      'Local CRDT redo failed',
    );
    console.log('PASS local-only Yjs undo and redo');
    await client.rename(note.id, 'Renamed remotely');
    await vscode.commands.executeCommand('typo.refreshNotes');
    assert.equal(
      api.notes.getChildren().find((n) => n.id === note.id)?.title,
      'Renamed remotely',
    );
    const sameUri = await vscode.commands.executeCommand<vscode.Uri>(
      'typo.openNote',
      { ...note, title: 'Renamed remotely' },
    );
    assert.equal(
      sameUri.toString(),
      uri.toString(),
      'Rename must not create a second binding',
    );
    console.log('PASS sidebar refresh and stable editor URI after rename');
    await page.close();
    await until(
      () =>
        api.presence.getChildren().length === 1 &&
        !api.presence
          .getChildren()
          .some((member) => member.user.name === 'Web Bob'),
      'Web peer remained online after closing',
    );
    await document.save();
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    await client.delete(note.id);
    await vscode.commands.executeCommand('typo.refreshNotes');
    assert.ok(!api.notes.getChildren().some((n) => n.id === note.id));
    console.log('PASS close/dispose and sidebar deletion');
  } finally {
    await browser.close();
  }
}
