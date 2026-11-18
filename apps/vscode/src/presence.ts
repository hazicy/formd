import * as vscode from 'vscode';
import type { VscodeBinding } from '@typo/y-vscode';
import {
  captureSelection,
  resolveSelection,
  type NoteSession,
  type PresenceMember,
} from '@typo/client';
interface Entry {
  uri: vscode.Uri;
  session: NoteSession;
  binding?: VscodeBinding;
}
interface Decorations {
  color: string;
  cursor: vscode.TextEditorDecorationType;
  range: vscode.TextEditorDecorationType;
}
export class PresenceController
  implements vscode.TreeDataProvider<PresenceMember>, vscode.Disposable
{
  private readonly changed = new vscode.EventEmitter<
    PresenceMember | undefined
  >();
  readonly onDidChangeTreeData = this.changed.event;
  readonly view: vscode.TreeView<PresenceMember>;
  private subscriptions: vscode.Disposable[] = [];
  private attached = new Map<Entry, () => void>();
  private decorations = new Map<string, Decorations>();
  private selected?: Entry;
  private following?: string;
  private disposed = false;
  private renderPending = false;
  private selectionTimer?: ReturnType<typeof setTimeout>;
  constructor(
    private readonly entries: () => Iterable<Entry>,
    private readonly onChange: () => void,
  ) {
    this.view = vscode.window.createTreeView('typo.members', {
      treeDataProvider: this,
      showCollapseAll: false,
    });
    this.subscriptions.push(
      this.view,
      this.changed,
      vscode.window.onDidChangeActiveTextEditor(() => this.activateEditor()),
      vscode.window.onDidChangeVisibleTextEditors(() => this.schedule()),
      vscode.window.onDidChangeTextEditorSelection((event) => {
        if (event.textEditor.document.uri.scheme !== 'typo') return;
        if (
          event.kind === vscode.TextEditorSelectionChangeKind.Keyboard ||
          event.kind === vscode.TextEditorSelectionChangeKind.Mouse
        )
          this.stopFollowing();
        clearTimeout(this.selectionTimer);
        this.selectionTimer = setTimeout(() => {
          void this.publishSelection(event.textEditor);
        }, 40);
      }),
    );
    this.activateEditor();
  }
  attach(entry: Entry) {
    if (this.attached.has(entry)) return;
    const offPresence = entry.session.subscribePresence(() => {
      this.onChange();
      this.schedule();
    });
    const offContent = entry.session.subscribe(() => this.schedule());
    this.attached.set(entry, () => {
      offPresence();
      offContent();
    });
    this.activateEditor();
  }
  detach(entry: Entry) {
    this.attached.get(entry)?.();
    this.attached.delete(entry);
    if (this.selected === entry) {
      this.selected = undefined;
      this.stopFollowing();
    }
    this.schedule();
  }
  private activateEditor() {
    const editor = vscode.window.activeTextEditor;
    const selected =
      editor &&
      [...this.entries()].find(
        (entry) => entry.uri.toString() === editor.document.uri.toString(),
      );
    if (this.selected !== selected) {
      this.selected?.session.setSelection(null);
      this.following = undefined;
      this.selected = selected;
    }
    if (editor) void this.publishSelection(editor);
    this.schedule();
  }
  private async publishSelection(editor: vscode.TextEditor) {
    const entry = [...this.entries()].find(
      (entry) => entry.uri.toString() === editor.document.uri.toString(),
    );
    if (!entry?.binding || entry.session.status === 'deleted') return;
    try {
      await entry.binding.flush();
      if (
        this.disposed ||
        editor.document.isClosed ||
        vscode.window.activeTextEditor !== editor
      )
        return;
      const selection = editor.selection;
      entry.session.setSelection(
        captureSelection(
          entry.binding.viewText,
          editor.document.offsetAt(selection.anchor),
          editor.document.offsetAt(selection.active),
        ),
      );
    } catch {
      /* binding error is already reported by the editor */
    }
  }
  getChildren(): PresenceMember[] {
    return [...(this.selected?.session.members || [])];
  }
  getTreeItem(member: PresenceMember): vscode.TreeItem {
    const self = member.id === this.selected?.session.connectionId;
    const item = new vscode.TreeItem(
      member.user.name + (self ? '（你）' : ''),
      vscode.TreeItemCollapsibleState.None,
    );
    item.id = member.id;
    item.contextValue = self ? 'typoSelf' : 'typoMember';
    item.description = `${member.user.client === 'vscode' ? 'VS Code' : member.user.client === 'web' ? 'Web' : '其他端'}${this.following === member.id ? ' · 正在跟随' : ''}`;
    const location = this.location(member.id);
    item.tooltip = `${member.user.name} · ${location ? `第 ${location.head.line + 1} 行，第 ${location.head.character + 1} 列` : '正在阅读'}`;
    // Per-member SVG keeps sidebar color consistent with the remote caret.
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><circle cx="8" cy="8" r="5" fill="${member.user.color}"/></svg>`;
    item.iconPath = vscode.Uri.parse(
      'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64'),
    );
    if (!self)
      item.command = {
        command: 'typo.jumpToMember',
        title: '定位成员光标',
        arguments: [member],
      };
    return item;
  }
  location(id: string) {
    const entry = this.selected,
      member = entry?.session.members.find((member) => member.id === id);
    if (!entry?.binding || !member) return null;
    const document = vscode.workspace.textDocuments.find(
      (document) => document.uri.toString() === entry.uri.toString(),
    );
    if (!document || document.getText() !== entry.binding.content) return null;
    const position = resolveSelection(entry.binding.viewText, member.selection);
    if (!position) return null;
    const anchor = document.positionAt(position.anchor),
      head = document.positionAt(position.head);
    return { document, head, range: new vscode.Range(anchor, head) };
  }
  get followingId() {
    return this.following;
  }
  async jumpToMember(member: PresenceMember, follow = false) {
    const location = this.location(member.id);
    if (!location) return;
    const editor = await vscode.window.showTextDocument(location.document, {
      preserveFocus: true,
    });
    if (follow) this.following = member.id;
    editor.revealRange(
      new vscode.Range(location.head, location.head),
      vscode.TextEditorRevealType.InCenterIfOutsideViewport,
    );
    this.schedule();
  }
  stopFollowing() {
    if (this.following) {
      this.following = undefined;
      this.schedule();
    }
  }
  private schedule() {
    if (this.disposed || this.renderPending) return;
    this.renderPending = true;
    void Promise.resolve()
      .then(() => this.render())
      .catch((error) => console.error('Typo presence:', error))
      .finally(() => {
        this.renderPending = false;
      });
  }
  private async render() {
    const entries = [...this.entries()];
    for (const entry of entries)
      try {
        await entry.binding?.flush();
      } catch {
        /* keep drafts visible */
      }
    if (this.disposed) return;
    const used = new Set<string>();
    for (const editor of vscode.window.visibleTextEditors) {
      const entry = entries.find(
        (entry) => entry.uri.toString() === editor.document.uri.toString(),
      );
      if (!entry?.binding) continue;
      for (const member of entry.session.members) {
        if (member.id === entry.session.connectionId) continue;
        const key = member.id;
        used.add(key);
        let style = this.decorations.get(key);
        if (style?.color !== member.user.color) {
          style?.cursor.dispose();
          style?.range.dispose();
          style = {
            color: member.user.color,
            cursor: vscode.window.createTextEditorDecorationType({
              borderStyle: 'solid',
              borderWidth: '0 0 0 2px',
              borderColor: member.user.color,
              rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
              overviewRulerColor: member.user.color,
              overviewRulerLane: vscode.OverviewRulerLane.Right,
            }),
            range: vscode.window.createTextEditorDecorationType({
              backgroundColor: member.user.color + '30',
              rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
            }),
          };
          this.decorations.set(key, style);
        }
        const selection = resolveSelection(
          entry.binding.viewText,
          member.selection,
        );
        const position = selection
          ? editor.document.positionAt(selection.head)
          : null;
        const hover = new vscode.MarkdownString().appendText(
          member.user.name + ' · ' + member.user.client,
        );
        editor.setDecorations(
          style.cursor,
          position
            ? [
                {
                  range: new vscode.Range(position, position),
                  hoverMessage: hover,
                  renderOptions: {
                    after: {
                      contentText: ` ${member.user.name} `,
                      color: '#ffffff',
                      backgroundColor: member.user.color,
                      margin: '0 0 0 2px',
                    },
                  },
                },
              ]
            : [],
        );
        editor.setDecorations(
          style.range,
          selection && selection.anchor !== selection.head
            ? [
                {
                  range: new vscode.Range(
                    editor.document.positionAt(selection.anchor),
                    editor.document.positionAt(selection.head),
                  ),
                  hoverMessage: hover,
                },
              ]
            : [],
        );
      }
    }
    for (const [id, style] of this.decorations)
      if (!used.has(id)) {
        style.cursor.dispose();
        style.range.dispose();
        this.decorations.delete(id);
      }
    if (this.following) {
      const location = this.location(this.following);
      if (location) {
        const editor = vscode.window.visibleTextEditors.find(
          (editor) => editor.document === location.document,
        );
        editor?.revealRange(
          new vscode.Range(location.head, location.head),
          vscode.TextEditorRevealType.InCenterIfOutsideViewport,
        );
      } else if (
        !this.selected?.session.members.some(
          (member) => member.id === this.following,
        )
      )
        this.following = undefined;
    }
    this.view.description = this.selected
      ? `${this.getChildren().length} 在线`
      : undefined;
    this.view.message = this.selected
      ? undefined
      : '打开一篇 Typo 文档，查看当前在线成员。';
    this.changed.fire(undefined);
  }
  dispose() {
    this.disposed = true;
    clearTimeout(this.selectionTimer);
    for (const off of this.attached.values()) off();
    for (const style of this.decorations.values()) {
      style.cursor.dispose();
      style.range.dispose();
    }
    for (const sub of this.subscriptions) sub.dispose();
  }
}
