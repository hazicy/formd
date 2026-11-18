import * as vscode from 'vscode';
import type { VscodeBinding } from '@formd/y-vscode';
import {
  captureSelection,
  resolveSelection,
  type NoteSession,
  type PresenceMember,
} from '@formd/client';
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
export class PresenceController implements vscode.Disposable {
  private readonly status = vscode.window.createStatusBarItem(
    'formd.members',
    vscode.StatusBarAlignment.Left,
    99,
  );
  private subscriptions: vscode.Disposable[] = [];
  private attached = new Map<Entry, () => void>();
  private decorations = new Map<string, Decorations>();
  private selected?: Entry;
  private following?: string;
  private disposed = false;
  private renderPending = false;
  private selectionTimer?: ReturnType<typeof setTimeout>;
  constructor(private readonly entries: () => Iterable<Entry>) {
    this.status.name = vscode.l10n.t('Formd Online Members');
    this.status.command = 'formd.showMembers';
    this.subscriptions.push(
      this.status,
      vscode.window.onDidChangeActiveTextEditor(() => this.activateEditor()),
      vscode.window.onDidChangeVisibleTextEditors(() => this.schedule()),
      vscode.window.onDidChangeTextEditorSelection((event) => {
        if (event.textEditor.document.uri.scheme !== 'formd') return;
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
  async showMembers() {
    const entry = this.selected;
    if (!entry) return;
    const items = this.getChildren().map((member) => {
      const self = member.id === entry.session.connectionId;
      const location = this.location(member.id);
      return {
        label: member.user.name + (self ? vscode.l10n.t(' (you)') : ''),
        description: `${member.user.client === 'vscode' ? 'VS Code' : member.user.client === 'web' ? 'Web' : member.user.client === 'agent' ? 'Agent' : vscode.l10n.t('Other client')}${this.following === member.id ? vscode.l10n.t(' · Following') : ''}`,
        detail: location
          ? vscode.l10n.t(
              'Line {0}, column {1}',
              location.head.line + 1,
              location.head.character + 1,
            )
          : vscode.l10n.t('Reading'),
        member,
      };
    });
    const stopItem = {
      label: vscode.l10n.t('$(debug-stop) Stop Following'),
      description: '',
      detail: '',
      member: undefined,
    };
    const picked = await vscode.window.showQuickPick(
      this.following ? [stopItem, ...items] : items,
      {
        title: vscode.l10n.t(
          'Online members · {0} (including you)',
          items.length,
        ),
        placeHolder: vscode.l10n.t('Select a member to jump to or follow'),
        matchOnDescription: true,
      },
    );
    if (!picked || this.selected !== entry) return;
    if (!picked.member) {
      this.stopFollowing();
      return;
    }
    if (picked.member.id === entry.session.connectionId) return;
    const action = await vscode.window.showQuickPick(
      [vscode.l10n.t('Jump to Cursor'), vscode.l10n.t('Follow Member')],
      {
        title: picked.member.user.name,
        placeHolder: vscode.l10n.t('Choose an action'),
      },
    );
    if (!action || this.selected !== entry) return;
    await this.jumpToMember(
      picked.member,
      action === vscode.l10n.t('Follow Member'),
    );
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
      .catch((error) => console.error('Formd presence:', error))
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
    if (this.selected) {
      const members = this.getChildren();
      const followed = members.find((member) => member.id === this.following);
      this.status.text = followed
        ? vscode.l10n.t(
            '$(organization) {0} online · Following {1}',
            members.length,
            followed.user.name,
          )
        : vscode.l10n.t('$(organization) {0} online', members.length);
      this.status.tooltip = new vscode.MarkdownString().appendText(
        vscode.l10n.t(
          'Online in this document (including you): {0}\nClick to view members, jump to a cursor, or manage following.',
          new Intl.ListFormat(vscode.env.language).format(
            members.map((member) => member.user.name),
          ) || vscode.l10n.t('None'),
        ),
      );
      this.status.show();
    } else {
      this.status.hide();
    }
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
