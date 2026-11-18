import * as vscode from 'vscode';
import type { Note } from '@formd/client';

type RecentNote = Note & { visitedAt: number };

export class RecentView
  implements vscode.TreeDataProvider<RecentNote>, vscode.Disposable
{
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly view: vscode.TreeView<RecentNote>;
  private records: Record<string, RecentNote[]>;

  constructor(
    private readonly state: vscode.Memento,
    private readonly server: () => string,
  ) {
    this.records = state.get('formd.recentNotes', {});
    this.view = vscode.window.createTreeView('formd.recent', {
      treeDataProvider: this,
    });
    this.refresh();
  }

  private get key() {
    return this.server().replace(/\/+$/, '');
  }

  getChildren(): RecentNote[] {
    return this.records[this.key] ?? [];
  }

  getTreeItem(note: RecentNote): vscode.TreeItem {
    const item = new vscode.TreeItem(note.title);
    item.id = note.id;
    item.contextValue = 'formdNote';
    item.iconPath = new vscode.ThemeIcon('markdown');
    item.tooltip = vscode.l10n.t(
      '{0}\nVisited {1}',
      note.title,
      new Date(note.visitedAt).toLocaleString(vscode.env.language),
    );
    item.command = {
      command: 'formd.openNote',
      title: vscode.l10n.t('Open Document'),
      arguments: [note],
    };
    return item;
  }

  visit(note: Note) {
    this.records[this.key] = [
      { ...note, visitedAt: Date.now() },
      ...this.getChildren().filter((item) => item.id !== note.id),
    ].slice(0, 20);
    this.save();
  }

  reconcile(server: string, notes: Note[]) {
    const key = server.replace(/\/+$/, '');
    const byId = new Map(notes.map((note) => [note.id, note]));
    this.records[key] = (this.records[key] ?? [])
      .filter((note) => byId.has(note.id))
      .map((note) => ({ ...note, ...byId.get(note.id)! }));
    this.save();
  }

  clear() {
    this.records[this.key] = [];
    this.save();
  }

  refresh() {
    this.view.message = this.getChildren().length
      ? undefined
      : vscode.l10n.t('Recently opened collaborative documents appear here.');
    this.changed.fire();
  }

  private save() {
    this.refresh();
    void this.state
      .update('formd.recentNotes', this.records)
      .then(undefined, (error) => console.error('Formd recent notes:', error));
  }

  dispose() {
    this.view.dispose();
    this.changed.dispose();
  }
}
