import { folderPath, pickDestination } from './folder-picker.js';
import * as vscode from 'vscode';
import WebSocket from 'ws';
import {
  FormdClient,
  markdownFilename,
  type Note,
  type Folder,
  createGuestUser,
  validPresenceUser,
  type PresenceUser,
  type PresenceMember,
} from '@formd/client';
import { RecentView } from './recent-view.js';
import { NotesView } from './notes-view.js';
import { PresenceController } from './presence.js';
import { DocumentSessions } from './documents/session-manager.js';
import { documentUri, type DocumentKey } from './documents/document-key.js';
import { createFileSystemProvider } from './documents/file-system-provider.js';
import { DraftStore } from './documents/draft-store.js';
import { createConnectionStatus } from './connection-status.js';
Object.defineProperty(globalThis, 'WebSocket', {
  value: WebSocket,
  configurable: true,
});
export function activate(context: vscode.ExtensionContext) {
  const changes = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  const output = vscode.window.createOutputChannel('Formd');
  const stored = context.globalState.get<PresenceUser>('formd.profile');
  const profile = validPresenceUser(stored)
    ? stored
    : createGuestUser('vscode');
  void context.globalState.update('formd.profile', profile);
  function getProfile(): PresenceUser {
    const config = vscode.workspace.getConfiguration('formd');
    return {
      ...profile,
      name:
        config.get<string>('displayName')?.trim().slice(0, 48) || profile.name,
      color: /^#[0-9a-fA-F]{6}$/.test(config.get<string>('cursorColor') || '')
        ? config.get<string>('cursorColor')!
        : profile.color,
      client: 'vscode',
    };
  }
  const client = (
    server = vscode.workspace
      .getConfiguration('formd')
      .get('serverUrl', 'http://localhost:3001'),
  ) => new FormdClient(server, getProfile());
  const recent = new RecentView(context.globalState, () => client().baseUrl);
  const tree = new NotesView(client, (server, notes) =>
    recent.reconcile(server, notes),
  );
  function report(error: unknown) {
    output.appendLine(String(error));
    void vscode.window.showErrorMessage(`Formd: ${String(error)}`);
  }
  const drafts = new DraftStore(
    vscode.Uri.joinPath(context.globalStorageUri, 'drafts').fsPath,
    vscode.Uri.joinPath(
      context.globalStorageUri,
      '..',
      'typo-local.typo-vscode',
      'drafts',
    ).fsPath,
  );
  const sessions: DocumentSessions = new DocumentSessions(
    client,
    drafts,
    output,
    report,
    (entry) => presence.attach(entry),
    (entry) => presence.detach(entry),
  );
  const presence = new PresenceController(() => sessions.values());
  const provider = createFileSystemProvider(sessions, changes.event);
  context.subscriptions.push(
    sessions,
    changes,
    output,
    tree,
    presence,
    recent,
    createConnectionStatus(sessions),
    sessions.onDidDelete((uri) => {
      changes.fire([{ type: vscode.FileChangeType.Deleted, uri }]);
      void tree.refresh();
    }),
  );
  context.subscriptions.push(
    vscode.workspace.registerFileSystemProvider('formd', provider, {
      isCaseSensitive: true,
    }),
  );
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((document) =>
      sessions.bind(document),
    ),
  );
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor?.document.uri.scheme !== 'formd') return;
      const key = sessions.getByUri(editor.document.uri)?.key;
      if (!key || key.server !== client().baseUrl) return;
      const note = tree.findNote(key.noteId);
      if (note) recent.visit(note);
    }),
  );
  for (const document of vscode.workspace.textDocuments)
    sessions.bind(document);
  const register = <T = Note>(
    name: string,
    fn: (item?: T) => Promise<unknown>,
  ) => {
    context.subscriptions.push(
      vscode.commands.registerCommand(name, (item?: T) =>
        fn(item).catch(report),
      ),
    );
  };
  async function choose(
    note: Note | undefined,
    target: FormdClient,
  ): Promise<Note | undefined> {
    if (note?.id) return note;
    const recentOrder = new Map(
      recent.getChildren().map((entry, index) => [entry.id, index]),
    );
    const [notes, folders] = await Promise.all([
      target.list(),
      target.listFolders(),
    ]);
    const byId = new Map(folders.map((folder) => [folder.id, folder]));
    notes.sort(
      (a, b) =>
        (recentOrder.get(a.id) ?? recentOrder.size) -
        (recentOrder.get(b.id) ?? recentOrder.size),
    );
    const picked = await vscode.window.showQuickPick(
      notes.map((note) => ({
        label: note.title,
        description:
          folderPath(byId, note.folderId)
            .map((folder) => folder.name)
            .join(' / ') || vscode.l10n.t('Root'),
        note,
      })),
      {
        placeHolder: vscode.l10n.t(
          'Search Formd documents by title or folder path',
        ),
        matchOnDescription: true,
      },
    );
    return picked?.note;
  }
  async function openDocument(key: DocumentKey, filename: string) {
    // Keep the displayed filename stable while a document is open.
    const uri = sessions.get(key)?.uri ?? documentUri(key, filename);
    const document = await vscode.workspace.openTextDocument(uri);
    sessions.bind(document);
    await vscode.window.showTextDocument(document);
    return uri;
  }
  async function open(note: Note, server: string) {
    const uri = await openDocument(
      { server, noteId: note.id },
      markdownFilename(note.title),
    );
    if (server === client().baseUrl) recent.visit(note);
    return uri;
  }
  register('formd.recoverDraft', async () => {
    const { baseUrl } = client();
    const available = drafts.list(baseUrl);
    if (!available.length) {
      void vscode.window.showInformationMessage(
        vscode.l10n.t('No local Formd drafts for this server.'),
      );
      return;
    }
    const picked = await vscode.window.showQuickPick(
      available.map((draft) => ({ label: draft.filename, draft })),
      { placeHolder: vscode.l10n.t('Choose a local Formd draft') },
    );
    if (!picked) return;
    const action = await vscode.window.showQuickPick([
      { label: vscode.l10n.t('Resume collaboration'), resume: true },
      { label: vscode.l10n.t('Open a local copy'), resume: false },
    ]);
    if (!action) return;
    const { key, filename } = picked.draft;
    if (action.resume) {
      await openDocument(key, filename);
      return;
    }
    sessions.get(key)?.draft.flush();
    const content = drafts.read(key);
    if (content !== undefined)
      await vscode.window.showTextDocument(
        await vscode.workspace.openTextDocument({
          language: 'markdown',
          content,
        }),
      );
  });
  register('formd.exportMarkdown', async () => {
    const document = vscode.window.activeTextEditor?.document;
    if (document?.uri.scheme !== 'formd') return;
    const destination = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.joinPath(
        vscode.workspace.workspaceFolders?.[0]?.uri ??
          vscode.Uri.file(process.cwd()),
        document.uri.path.split('/').at(-1)!,
      ),
      filters: { Markdown: ['md'] },
    });
    if (destination)
      await vscode.workspace.fs.writeFile(
        destination,
        new TextEncoder().encode(document.getText()),
      );
  });
  register('formd.retrySync', async () => {
    const document = vscode.window.activeTextEditor?.document;
    if (document?.uri.scheme === 'formd')
      sessions.getByUri(document.uri)?.session.retryPersistence();
  });
  register('formd.openNote', async (note) => {
    const target = client();
    const selected = await choose(note, target);
    if (selected) return open(selected, target.baseUrl);
  });
  register<Folder>('formd.createNote', async (folder) => {
    const target = client();
    const title = await vscode.window.showInputBox({
      prompt: folder?.id
        ? vscode.l10n.t('Create document in “{0}”', folder.name)
        : vscode.l10n.t('Document title'),
      value: vscode.l10n.t('Untitled document'),
    });
    if (title === undefined) return;
    const note = await target.create(title, undefined, folder?.id);
    await tree.refresh();
    return open(note, target.baseUrl);
  });
  register<Folder>('formd.createFolder', async (folder) => {
    const target = client();
    const name = await vscode.window.showInputBox({
      prompt: folder?.id
        ? vscode.l10n.t('Create folder in “{0}”', folder.name)
        : vscode.l10n.t('Create a folder at the root'),
      placeHolder: vscode.l10n.t('Folder name'),
      validateInput: (value) =>
        value.trim() ? undefined : vscode.l10n.t('Enter a folder name'),
    });
    if (!name?.trim()) return;
    await target.createFolder(name.trim(), folder?.id);
    await tree.refresh();
  });
  register('formd.moveNote', async (note) => {
    const target = client();
    const selected = await choose(note, target);
    if (!selected) return;
    const destination = await pickDestination(target, selected.folderId);
    if (!destination) return;
    await target.move(selected.id, destination.id);
    await tree.refresh();
  });
  register<Folder>('formd.renameFolder', async (folder) => {
    if (!folder?.id) return;
    const target = client();
    const name = (
      await vscode.window.showInputBox({
        prompt: vscode.l10n.t('Rename Formd folder'),
        value: folder.name,
        validateInput: (value) =>
          value.trim() ? undefined : vscode.l10n.t('Enter a folder name'),
      })
    )?.trim();
    if (!name || name === folder.name) return;
    await target.updateFolder(folder.id, { name });
    await tree.refresh();
  });
  register<Folder>('formd.moveFolder', async (folder) => {
    if (!folder?.id) return;
    const target = client();
    const destination = await pickDestination(
      target,
      folder.parentId,
      folder.id,
    );
    if (!destination) return;
    await target.updateFolder(folder.id, { parentId: destination.id });
    await tree.refresh();
  });
  register<Folder>('formd.deleteFolder', async (folder) => {
    if (!folder?.id) return;
    const target = client();
    if (
      (await vscode.window.showWarningMessage(
        vscode.l10n.t(
          'Permanently delete the empty folder “{0}”?',
          folder.name,
        ),
        { modal: true },
        vscode.l10n.t('Delete'),
      )) !== vscode.l10n.t('Delete')
    )
      return;
    await target.deleteFolder(folder.id);
    await tree.refresh();
  });
  register('formd.clearRecent', async () => recent.clear());
  register('formd.refreshNotes', () => tree.refresh());
  register('formd.renameNote', async (note) => {
    const target = client();
    const selected = await choose(note, target);
    if (!selected) return;
    const title = await vscode.window.showInputBox({
      prompt: vscode.l10n.t('Document title'),
      value: selected.title,
    });
    if (title === undefined) return;
    await target.rename(selected.id, title);
    await tree.refresh();
  });
  register('formd.deleteNote', async (note) => {
    const target = client();
    const selected = await choose(note, target);
    if (!selected) return;
    if (
      (await vscode.window.showWarningMessage(
        vscode.l10n.t('Permanently delete “{0}”?', selected.title),
        { modal: true },
        vscode.l10n.t('Delete'),
      )) === vscode.l10n.t('Delete')
    ) {
      await target.delete(selected.id);
      await tree.refresh();
    }
  });
  register('formd.openInBrowser', async (note) => {
    const target = client();
    const selected = await choose(note, target);
    if (!selected) return;
    const base = vscode.workspace
      .getConfiguration('formd')
      .get('webUrl', 'http://localhost:5173');
    const url = new URL(base);
    url.hash = selected.id;
    await vscode.env.openExternal(vscode.Uri.parse(url.toString()));
  });
  register('formd.configureServer', async () => {
    const config = vscode.workspace.getConfiguration('formd');
    const server = await vscode.window.showInputBox({
      prompt: vscode.l10n.t('Formd server URL'),
      value: config.get('serverUrl', 'http://localhost:3001'),
      validateInput: (value) => {
        try {
          const url = new URL(value);
          return ['http:', 'https:'].includes(url.protocol)
            ? undefined
            : vscode.l10n.t('Use an http:// or https:// URL');
        } catch {
          return vscode.l10n.t('Enter a valid server URL');
        }
      },
    });
    if (server === undefined) return;
    await config.update('serverUrl', server, vscode.ConfigurationTarget.Global);
  });
  for (const command of ['undo', 'redo'] as const)
    register(`formd.${command}`, async () => {
      const document = vscode.window.activeTextEditor?.document;
      if (document?.uri.scheme === 'formd')
        await sessions.getByUri(document.uri)?.binding?.[command]();
    });
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration('formd.displayName') ||
        event.affectsConfiguration('formd.cursorColor')
      )
        for (const entry of sessions.values())
          entry.session.setUser(getProfile());
      if (event.affectsConfiguration('formd.serverUrl')) {
        recent.refresh();
        void tree.refresh();
      }
    }),
  );
  context.subscriptions.push(
    vscode.workspace.onDidCloseTextDocument(
      (document) => void sessions.close(document),
    ),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('formd.showMembers', () =>
      presence.showMembers(),
    ),
    vscode.commands.registerCommand(
      'formd.jumpToMember',
      (member: PresenceMember) => presence.jumpToMember(member),
    ),
    vscode.commands.registerCommand(
      'formd.followMember',
      (member: PresenceMember) => presence.jumpToMember(member, true),
    ),
    vscode.commands.registerCommand('formd.stopFollowing', () =>
      presence.stopFollowing(),
    ),
  );
  return { notes: tree, presence };
}
