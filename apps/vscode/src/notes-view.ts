import * as vscode from 'vscode';
import { TypoClient, type Folder, type Note } from '@typo/client';

type TreeEntry = Folder | Note;

export class NotesView
  implements vscode.TreeDataProvider<TreeEntry>, vscode.Disposable
{
  private readonly changes = new vscode.EventEmitter<TreeEntry | undefined>();
  readonly onDidChangeTreeData = this.changes.event;
  private notes: Note[] = [];
  private folders: Folder[] = [];
  private generation = 0;
  private disposed = false;
  private readonly timer: ReturnType<typeof setInterval>;
  readonly view: vscode.TreeView<TreeEntry>;

  constructor(
    private readonly client: () => TypoClient,
    private readonly onRefresh?: (server: string, notes: Note[]) => void,
  ) {
    this.view = vscode.window.createTreeView('typo.notes', {
      treeDataProvider: this,
      showCollapseAll: true,
    });
    this.timer = setInterval(() => {
      if (this.view.visible) void this.refresh();
    }, 5000);
    this.view.onDidChangeVisibility((event) => {
      if (event.visible) void this.refresh();
    });
    void this.refresh();
  }
  findNote(id: string) {
    return this.notes.find((note) => note.id === id);
  }

  getChildren(entry?: TreeEntry): TreeEntry[] {
    if (entry && !('parentId' in entry)) return [];
    const parentId = entry?.id ?? null;
    return [
      ...this.folders.filter((folder) => folder.parentId === parentId),
      ...this.notes.filter((note) => note.folderId === parentId),
    ];
  }

  getTreeItem(note: TreeEntry): vscode.TreeItem {
    if ('parentId' in note) {
      const item = new vscode.TreeItem(
        note.name,
        vscode.TreeItemCollapsibleState.Collapsed,
      );
      item.id = `folder:${note.id}`;
      item.contextValue = 'typoFolder';
      item.iconPath = vscode.ThemeIcon.Folder;
      return item;
    }
    const item = new vscode.TreeItem(
      note.title,
      vscode.TreeItemCollapsibleState.None,
    );
    item.id = note.id;
    item.contextValue = 'typoNote';
    item.iconPath = new vscode.ThemeIcon('markdown');
    item.tooltip = vscode.l10n.t(
      '{0}\nUpdated {1}\n{2}',
      note.title,
      new Date(note.updatedAt).toLocaleString(vscode.env.language),
      note.id,
    );
    item.command = {
      command: 'typo.openNote',
      title: vscode.l10n.t('Open Document'),
      arguments: [note],
    };
    return item;
  }
  async refresh(): Promise<Note[]> {
    const generation = ++this.generation;
    const client = this.client();
    try {
      this.view.description = new URL(client.baseUrl).host;
      const [notes, folders] = await Promise.all([
        client.list(),
        client.listFolders(),
      ]);
      if (this.disposed || generation !== this.generation) return this.notes;
      this.notes = notes;
      this.folders = folders;
      this.onRefresh?.(client.baseUrl, notes);
      this.view.message =
        notes.length || folders.length
          ? undefined
          : vscode.l10n.t('No documents yet. Click + to create one.');
      this.changes.fire(undefined);
    } catch (error) {
      if (!this.disposed && generation === this.generation) {
        this.view.message = vscode.l10n.t(
          'Could not connect to the server: {0}. Start the backend or configure its URL, then refresh.',
          String(error),
        );
      }
    }
    return this.notes;
  }
  dispose() {
    this.disposed = true;
    clearInterval(this.timer);
    this.changes.dispose();
    this.view.dispose();
  }
}
