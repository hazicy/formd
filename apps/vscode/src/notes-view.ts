import * as vscode from 'vscode';
import { TypoClient, type Note } from '@typo/client';

export class NotesView
  implements vscode.TreeDataProvider<Note>, vscode.Disposable
{
  private readonly changes = new vscode.EventEmitter<Note | undefined>();
  readonly onDidChangeTreeData = this.changes.event;
  private notes: Note[] = [];
  private generation = 0;
  private disposed = false;
  private readonly timer: ReturnType<typeof setInterval>;
  readonly view: vscode.TreeView<Note>;

  constructor(private readonly client: () => TypoClient) {
    this.view = vscode.window.createTreeView('typo.notes', {
      treeDataProvider: this,
      showCollapseAll: false,
    });
    this.timer = setInterval(() => {
      if (this.view.visible) void this.refresh();
    }, 5000);
    this.view.onDidChangeVisibility((event) => {
      if (event.visible) void this.refresh();
    });
    void this.refresh();
  }
  getChildren(): Note[] {
    return this.notes;
  }
  getTreeItem(note: Note): vscode.TreeItem {
    const item = new vscode.TreeItem(
      note.title,
      vscode.TreeItemCollapsibleState.None,
    );
    item.id = note.id;
    item.contextValue = 'typoNote';
    item.iconPath = new vscode.ThemeIcon('markdown');
    item.tooltip = `${note.title}\n更新于 ${new Date(note.updatedAt).toLocaleString()}\n${note.id}`;
    item.command = {
      command: 'typo.openNote',
      title: '打开文档',
      arguments: [note],
    };
    return item;
  }
  async refresh(): Promise<Note[]> {
    const generation = ++this.generation;
    const client = this.client();
    try {
      this.view.description = new URL(client.baseUrl).host;
      const notes = await client.list();
      if (this.disposed || generation !== this.generation) return this.notes;
      this.notes = notes;
      this.view.message = notes.length
        ? undefined
        : '还没有文档，点击上方 + 创建第一篇。';
      this.changes.fire(undefined);
    } catch (error) {
      if (!this.disposed && generation === this.generation) {
        this.view.message = `无法连接服务器：${String(error)}。启动后端或点击齿轮配置地址，再刷新重试。`;
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
