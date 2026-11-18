import * as vscode from 'vscode';
import WebSocket from 'ws';
import * as Y from 'yjs';
import { VscodeBinding } from '@typo/y-vscode';
import {
  TypoClient,
  markdownFilename,
  type Note,
  type NoteSession,
  createGuestUser,
  validPresenceUser,
  type PresenceUser,
  type PresenceMember,
} from '@typo/client';
import { NotesView } from './notes-view.js';
import { PresenceController } from './presence.js';
Object.defineProperty(globalThis, 'WebSocket', {
  value: WebSocket,
  configurable: true,
});
const encoder = new TextEncoder();
interface Entry {
  session: NoteSession;
  uri: vscode.Uri;
  mtime: number;
  initialState?: Uint8Array;
  binding?: VscodeBinding;
  unsubscribe: () => void;
}
const labels = {
  connecting: '正在连接',
  connected: '实时协作',
  offline: '离线 · 等待重连',
  deleted: '文档已删除',
  error: '同步失败',
};
export function activate(context: vscode.ExtensionContext) {
  const changes = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  const entries = new Map<string, Entry>();
  const output = vscode.window.createOutputChannel('Typo');
  const status = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
  );
  status.command = 'typo.notes.focus';
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
  const tree = new NotesView(client);
  const presence = new PresenceController(
    () => entries.values(),
    () => updateStatus(),
  );
  const idOf = (uri: vscode.Uri) => uri.path.split('/')[1];
  context.subscriptions.push(changes, status, output, tree, presence);
  function report(error: unknown) {
    output.appendLine(String(error));
    void vscode.window.showErrorMessage(`Typo: ${String(error)}`);
  }
  function updateStatus() {
    const document = vscode.window.activeTextEditor?.document;
    const entry =
      document?.uri.scheme === 'typo'
        ? entries.get(idOf(document.uri))
        : undefined;
    if (!entry) {
      status.hide();
      return;
    }
    status.text = entry.binding?.isFailed
      ? '$(warning) Typo · 绑定暂停'
      : `$(sync) Typo · ${labels[entry.session.status]} · ${entry.session.members.length} 在线`;
    status.tooltip =
      '正文逐次编辑自动同步；无需保存。断线草稿保存在当前会话内存中。';
    status.show();
  }
  function getEntry(uri: vscode.Uri): Entry {
    const id = idOf(uri);
    const existing = entries.get(id);
    if (existing) return existing;
    const session = client().connect(id);
    const entry: Entry = {
      session,
      uri,
      mtime: Date.now(),
      unsubscribe: () => {},
    };
    entries.set(id, entry);
    entry.unsubscribe = session.subscribe(() => {
      updateStatus();
      if (session.status === 'deleted') {
        entry.binding?.dispose();
        entry.binding = undefined;
        changes.fire([{ type: vscode.FileChangeType.Deleted, uri: entry.uri }]);
        void tree.refresh();
      }
      // Bound editors consume Y.Text deltas directly. File-change notifications
      // here would invoke VS Code's disk-conflict path for unsaved live input.
    });
    return entry;
  }
  async function ready(session: NoteSession) {
    if (session.status === 'connected') return;
    if (session.status === 'deleted' || session.status === 'error')
      throw vscode.FileSystemError.Unavailable('文档不存在或同步失败');
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        stop();
        reject(new Error('连接超时，请检查 Typo 服务地址'));
      }, 10000);
      const stop = session.subscribe(() => {
        if (session.status === 'connected') {
          clearTimeout(timer);
          stop();
          resolve();
        }
        if (session.status === 'deleted' || session.status === 'error') {
          clearTimeout(timer);
          stop();
          reject(new Error('文档不存在或同步失败'));
        }
      });
    });
  }
  function bind(document: vscode.TextDocument) {
    if (document.uri.scheme !== 'typo') return;
    const entry = getEntry(document.uri);
    if (entry.binding || entry.session.status === 'deleted') return;
    try {
      entry.binding = new VscodeBinding(
        entry.session.text,
        document,
        (error) => {
          output.appendLine(error.stack || error.message);
          updateStatus();
          void vscode.window.showErrorMessage(
            `Typo 实时绑定已暂停：${error.message}。请先导出当前正文，再重新打开文档。`,
          );
        },
        entry.initialState,
      );
      presence.attach(entry);
      updateStatus();
    } catch (error) {
      report(error);
    }
  }
  const provider: vscode.FileSystemProvider = {
    onDidChangeFile: changes.event,
    watch: () => new vscode.Disposable(() => {}),
    stat: (uri) => {
      const entry = getEntry(uri);
      if (entry.session.status === 'deleted')
        throw vscode.FileSystemError.FileNotFound(uri);
      return {
        type: vscode.FileType.File,
        ctime: 0,
        mtime: entry.mtime,
        size: encoder.encode(
          entry.binding?.content ?? entry.session.text.toString(),
        ).length,
      };
    },
    readDirectory: () => [],
    createDirectory: () => {
      throw vscode.FileSystemError.NoPermissions();
    },
    readFile: async (uri) => {
      const entry = getEntry(uri);
      if (entry.binding) return encoder.encode(entry.binding.content);
      await ready(entry.session);
      // Preserve the exact state returned to VS Code; a remote update may arrive
      // before onDidOpenTextDocument. The binding rebases from this snapshot.
      entry.initialState = Y.encodeStateAsUpdate(entry.session.doc);
      return encoder.encode(entry.session.text.toString());
    },
    writeFile: async (uri, _bytes) => {
      const entry = getEntry(uri);
      if (!entry.binding)
        throw vscode.FileSystemError.Unavailable(
          '文档未绑定到协作会话，请重新打开',
        );
      await entry.binding.flush();
      // Local content changes already reached Yjs. A save must never replace
      // merged CRDT content using an older, in-flight editor snapshot.
      entry.mtime = Math.max(Date.now(), entry.mtime + 1);
    },
    delete: () => {
      throw vscode.FileSystemError.NoPermissions('请使用 Typo: 删除协作文档');
    },
    rename: () => {
      throw vscode.FileSystemError.NoPermissions('请使用 Typo: 重命名文档');
    },
  };
  context.subscriptions.push(
    vscode.workspace.registerFileSystemProvider('typo', provider, {
      isCaseSensitive: true,
    }),
  );
  context.subscriptions.push(vscode.workspace.onDidOpenTextDocument(bind));
  for (const document of vscode.workspace.textDocuments) bind(document);
  const register = (name: string, fn: (note?: Note) => Promise<unknown>) => {
    context.subscriptions.push(
      vscode.commands.registerCommand(name, (note?: Note) =>
        fn(note).catch(report),
      ),
    );
  };
  async function choose(note?: Note): Promise<Note | undefined> {
    if (note?.id) return note;
    const notes = await client().list();
    const picked = await vscode.window.showQuickPick(
      notes.map((note) => ({ label: note.title, description: note.id, note })),
      { placeHolder: '选择 Typo 文档' },
    );
    return picked?.note;
  }
  async function open(note: Note) {
    // A renamed document keeps its existing editor URI so it cannot get a second
    // binding, divergent dirty buffer or duplicate Y.UndoManager.
    const uri =
      entries.get(note.id)?.uri ??
      vscode.Uri.from({
        scheme: 'typo',
        path: `/${note.id}/${markdownFilename(note.title)}`,
      });
    const document = await vscode.workspace.openTextDocument(uri);
    bind(document);
    await vscode.window.showTextDocument(document);
    return uri;
  }
  register('typo.openNote', async (note) => {
    const selected = await choose(note);
    if (selected) return open(selected);
  });
  register('typo.createNote', async () => {
    const title = await vscode.window.showInputBox({
      prompt: '文档标题',
      value: '未命名文档',
    });
    if (title === undefined) return;
    const note = await client().create(title);
    await tree.refresh();
    return open(note);
  });
  register('typo.refreshNotes', () => tree.refresh());
  register('typo.renameNote', async (note) => {
    const selected = await choose(note);
    if (!selected) return;
    const title = await vscode.window.showInputBox({
      prompt: '文档标题',
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
        `永久删除「${selected.title}」？`,
        { modal: true },
        '删除',
      )) === '删除'
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
      prompt: 'Typo 服务器地址',
      value: config.get('serverUrl', 'http://localhost:3001'),
      validateInput: (value) => {
        try {
          const url = new URL(value);
          return ['http:', 'https:'].includes(url.protocol)
            ? undefined
            : '请使用 http:// 或 https:// 地址';
        } catch {
          return '请输入有效的服务器地址';
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
        await entries.get(idOf(document.uri))?.binding?.[command]();
    });
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(updateStatus),
  );
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration('typo.displayName') ||
        event.affectsConfiguration('typo.cursorColor')
      )
        for (const entry of entries.values())
          entry.session.setUser(getProfile());
      if (event.affectsConfiguration('typo.serverUrl')) {
        void tree.refresh();
        if (entries.size)
          void vscode.window.showInformationMessage(
            'Typo 服务器已切换。现有文档继续连接原服务器，请关闭协作文档后再打开其他服务器的文档。',
          );
      }
    }),
  );
  context.subscriptions.push(
    vscode.workspace.onDidCloseTextDocument((document) => {
      if (document.uri.scheme !== 'typo') return;
      const id = idOf(document.uri),
        entry = entries.get(id);
      if (!entry) return;
      void (async () => {
        try {
          await entry.binding?.flush();
        } catch (error) {
          output.appendLine(String(error));
        }
        if (!document.isClosed) return;
        presence.detach(entry);
        entry.binding?.dispose();
        entry.unsubscribe();
        entry.session.destroy();
        entries.delete(id);
        updateStatus();
      })();
    }),
  );
  context.subscriptions.push({
    dispose() {
      for (const entry of entries.values()) {
        presence.detach(entry);
        entry.binding?.dispose();
        entry.unsubscribe();
        entry.session.destroy();
      }
    },
  });
  context.subscriptions.push(
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
