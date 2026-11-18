import { folderPath, pickDestination } from './folder-picker.js';
import * as vscode from 'vscode';
import WebSocket from 'ws';
import {
  TypoClient,
  markdownFilename,
  type Note,
  type Folder,
  createGuestUser,
  validPresenceUser,
  type PresenceUser,
  type PresenceMember,
} from '@typo/client';
import { RecentView } from './recent-view.js';
import { NotesView } from './notes-view.js';
import { PresenceController } from './presence.js';
import { DocumentSessions, documentId } from './documents/session-manager.js';
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
  const stored = context.globalState.get<PresenceUser>('typo.profile');
  const profile = validPresenceUser(stored)
    ? stored
    : createGuestUser('vscode');
  void context.globalState.update('typo.profile', profile);
  function getProfile(): PresenceUser {
    const config = vscode.workspace.getConfiguration('typo');
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
  const client = () =>
    new TypoClient(
      vscode.workspace
        .getConfiguration('typo')
        .get('serverUrl', 'http://localhost:3001'),
      getProfile(),
    );
  const recent = new RecentView(context.globalState, () => client().baseUrl);
  const tree = new NotesView(client, (server, notes) =>
    recent.reconcile(server, notes),
  );
  function report(error: unknown) {
    output.appendLine(String(error));
    void vscode.window.showErrorMessage(`Formd: ${String(error)}`);
  }
  const sessions: DocumentSessions = new DocumentSessions(
    client,
    new DraftStore(
      vscode.Uri.joinPath(context.globalStorageUri, 'drafts').fsPath,
    ),
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
    vscode.workspace.registerFileSystemProvider('typo', provider, {
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
      if (editor?.document.uri.scheme !== 'typo') return;
      const note = tree.findNote(documentId(editor.document.uri));
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
  async function choose(note?: Note): Promise<Note | undefined> {
    if (note?.id) return note;
    const target = client();
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
  async function open(note: Note) {
    // A renamed document keeps its existing editor URI so it cannot get a second
    // binding, divergent dirty buffer or duplicate Y.UndoManager.
    const uri =
      sessions.get(note.id)?.uri ??
      vscode.Uri.from({
        scheme: 'typo',
        path: `/${note.id}/${markdownFilename(note.title)}`,
      });
    const document = await vscode.workspace.openTextDocument(uri);
    sessions.bind(document);
    await vscode.window.showTextDocument(document);
    recent.visit(note);
    return uri;
  }
  register('typo.openNote', async (note) => {
    const selected = await choose(note);
    if (selected) return open(selected);
  });
  register<Folder>('typo.createNote', async (folder) => {
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
    return open(note);
  });
  register<Folder>('typo.createFolder', async (folder) => {
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
  register('typo.moveNote', async (note) => {
    const target = client();
    const selected = await choose(note);
    if (!selected) return;
    const destination = await pickDestination(target, selected.folderId);
    if (!destination) return;
    await target.move(selected.id, destination.id);
    await tree.refresh();
  });
  register<Folder>('typo.renameFolder', async (folder) => {
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
  register<Folder>('typo.moveFolder', async (folder) => {
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
  register<Folder>('typo.deleteFolder', async (folder) => {
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
  register('typo.clearRecent', async () => recent.clear());
  register('typo.refreshNotes', () => tree.refresh());
  register('typo.renameNote', async (note) => {
    const selected = await choose(note);
    if (!selected) return;
    const title = await vscode.window.showInputBox({
      prompt: vscode.l10n.t('Document title'),
      value: selected.title,
    });
    if (title === undefined) return;
    await client().rename(selected.id, title);
    await tree.refresh();
  });
  register('typo.deleteNote', async (note) => {
    const selected = await choose(note);
    if (!selected) return;
    if (
      (await vscode.window.showWarningMessage(
        vscode.l10n.t('Permanently delete “{0}”?', selected.title),
        { modal: true },
        vscode.l10n.t('Delete'),
      )) === vscode.l10n.t('Delete')
    ) {
      await client().delete(selected.id);
      await tree.refresh();
    }
  });
  register('typo.openInBrowser', async (note) => {
    const selected = await choose(note);
    if (!selected) return;
    const base = vscode.workspace
      .getConfiguration('typo')
      .get('webUrl', 'http://localhost:5173');
    const url = new URL(base);
    url.hash = selected.id;
    await vscode.env.openExternal(vscode.Uri.parse(url.toString()));
  });
  register('typo.configureServer', async () => {
    const config = vscode.workspace.getConfiguration('typo');
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
    register(`typo.${command}`, async () => {
      const document = vscode.window.activeTextEditor?.document;
      if (document?.uri.scheme === 'typo')
        await sessions.get(documentId(document.uri))?.binding?.[command]();
    });
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration('typo.displayName') ||
        event.affectsConfiguration('typo.cursorColor')
      )
        for (const entry of sessions.values())
          entry.session.setUser(getProfile());
      if (event.affectsConfiguration('typo.serverUrl')) {
        recent.refresh();
        void tree.refresh();
        if (sessions.size)
          void vscode.window.showInformationMessage(
            vscode.l10n.t(
              'Formd server changed. Open documents stay connected to the previous server. Close them before opening documents from another server.',
            ),
          );
      }
    }),
  );
  context.subscriptions.push(
    vscode.workspace.onDidCloseTextDocument(
      (document) => void sessions.close(document),
    ),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('typo.showMembers', () =>
      presence.showMembers(),
    ),
    vscode.commands.registerCommand(
      'typo.jumpToMember',
      (member: PresenceMember) => presence.jumpToMember(member),
    ),
    vscode.commands.registerCommand(
      'typo.followMember',
      (member: PresenceMember) => presence.jumpToMember(member, true),
    ),
    vscode.commands.registerCommand('typo.stopFollowing', () =>
      presence.stopFollowing(),
    ),
  );
  return { notes: tree, presence };
}
