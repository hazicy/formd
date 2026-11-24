import * as vscode from 'vscode';
import {
  COMMENT_REACTIONS,
  captureCommentAnchor,
  resolveSelection,
  type CommentMessage,
  type NoteSession,
} from '@formd/client';
import type { VscodeBinding } from '@formd/y-vscode';

interface Entry {
  uri: vscode.Uri;
  session: NoteSession;
  binding?: VscodeBinding;
}

interface NativeThread {
  thread: vscode.CommentThread;
  comments?: Map<CommentMessage, vscode.Comment>;
}

const reactionIcons = new Map(
  COMMENT_REACTIONS.map((emoji) => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><text x="12" y="19" text-anchor="middle" font-size="19">${emoji}</text></svg>`;
    return [
      emoji,
      vscode.Uri.parse(
        `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`,
      ),
    ] as const;
  }),
);

export class DocumentComments implements vscode.Disposable {
  private readonly controller = vscode.comments.createCommentController(
    'formd',
    'Formd',
  );
  private readonly documents = new Map<
    string,
    {
      entry: Entry;
      threads: Map<string, NativeThread>;
      refresh: () => void;
      unsubscribe: () => void;
    }
  >();
  private readonly ids = new WeakMap<vscode.CommentThread, string>();
  private readonly commentIds = new WeakMap<
    vscode.Comment,
    { uri: string; id: string; message: CommentMessage }
  >();
  private readonly mentionProvider: vscode.Disposable;
  private readonly activeEditorListener: vscode.Disposable;
  private activeDocument =
    vscode.window.activeTextEditor?.document.uri.toString();
  private disposed = false;

  constructor(private readonly reactionActor: string) {
    this.activeEditorListener = vscode.window.onDidChangeActiveTextEditor(
      (editor) => {
        if (editor && editor.document.uri.scheme !== 'comment')
          this.activeDocument = editor.document.uri.toString();
      },
    );
    this.mentionProvider = vscode.languages.registerCompletionItemProvider(
      { scheme: 'comment' },
      {
        provideCompletionItems: (draft, position) => {
          if (draft.uri.authority !== this.controller.id) return;
          const session = this.activeDocument
            ? this.documents.get(this.activeDocument)?.entry.session
            : undefined;
          if (!session) return;
          const prefix = draft
            .lineAt(position.line)
            .text.slice(0, position.character);
          const mention = /(?:^|\s)@[^\s@]*$/.exec(prefix);
          if (!mention) return;
          const start = prefix.lastIndexOf('@');
          const names = new Set(
            session.members
              .filter((member) => member.id !== session.connectionId)
              .map((member) => member.user.name.trim())
              .filter(Boolean),
          );
          return [...names].map((name) => {
            const item = new vscode.CompletionItem(
              `@${name}`,
              vscode.CompletionItemKind.User,
            );
            item.range = new vscode.Range(
              position.line,
              start,
              position.line,
              position.character,
            );
            item.insertText = `@${name} `;
            return item;
          });
        },
      },
      '@',
    );
    this.controller.options = {
      placeHolder: vscode.l10n.t('Write a Formd comment'),
    };
    // Register reactions after options: VS Code replaces the controller's feature snapshot.
    this.controller.reactionHandler = async (comment, reaction) => {
      const target = this.commentIds.get(comment);
      const entry = target && this.documents.get(target.uri)?.entry;
      if (
        !target ||
        !entry ||
        entry.session.status === 'error' ||
        entry.session.status === 'deleted'
      )
        return;
      entry.session.comments.toggleReaction(
        target.id,
        target.message,
        reaction.label,
        this.reactionActor,
      );
    };
    this.controller.commentingRangeProvider = {
      provideCommentingRanges: (document) => {
        if (!this.documents.has(document.uri.toString())) return [];
        return [
          new vscode.Range(
            0,
            0,
            document.lineCount - 1,
            document.lineAt(document.lineCount - 1).text.length,
          ),
        ];
      },
    };
  }

  attach(entry: Entry) {
    const uri = entry.uri.toString();
    if (this.disposed || this.documents.has(uri)) return;
    const threads = new Map<string, NativeThread>();
    let refreshing = false;
    let requested = false;
    const refresh = async () => {
      requested = true;
      if (refreshing) return;
      refreshing = true;
      try {
        while (requested) {
          requested = false;
          const document = vscode.workspace.textDocuments.find(
            (document) => document.uri.toString() === uri,
          );
          const binding = entry.binding;
          if (entry.session.status === 'deleted') {
            this.detach(entry);
            return;
          }
          if (!document || !binding || binding.isFailed) return;
          await binding.flush();
          if (this.documents.get(uri)?.entry !== entry || document.isClosed)
            return;
          const records = entry.session.comments.list();
          const visibleIds = new Set(records.map((record) => record.id));
          for (const [id, native] of threads) {
            if (!visibleIds.has(id)) {
              native.thread.dispose();
              threads.delete(id);
            }
          }
          for (const record of records) {
            const selection = resolveSelection(binding.viewText, record.anchor);
            const range =
              selection &&
              new vscode.Range(
                document.positionAt(selection.anchor),
                document.positionAt(selection.head),
              );
            let native = threads.get(record.id);
            if (!native) {
              const thread = this.controller.createCommentThread(
                entry.uri,
                range ?? new vscode.Range(0, 0, 0, 0),
                [],
              );
              native = { thread };
              threads.set(record.id, native);
              this.ids.set(thread, record.id);
            }
            const { thread } = native;
            if (range ? !thread.range?.isEqual(range) : thread.range)
              thread.range = range ?? undefined;
            let changed = thread.comments.length !== record.messages.length;
            const next = new Map<CommentMessage, vscode.Comment>();
            for (const [index, message] of record.messages.entries()) {
              let comment = native.comments?.get(message);
              if (!comment) {
                comment = {
                  body: message.body,
                  mode: vscode.CommentMode.Preview,
                  author: { name: message.author },
                  timestamp: new Date(message.createdAt),
                  contextValue: 'formd-comment',
                };
                this.commentIds.set(comment, { uri, id: record.id, message });
              }
              const reactions = entry.session.comments.reactions(
                record.id,
                message,
                this.reactionActor,
              );
              if (
                !comment.reactions ||
                reactions.some(
                  (reaction, i) =>
                    reaction.count !== comment.reactions?.[i]?.count ||
                    reaction.authorHasReacted !==
                      comment.reactions?.[i]?.authorHasReacted,
                )
              ) {
                comment.reactions = reactions.map((reaction) => ({
                  ...reaction,
                  iconPath: reactionIcons.get(reaction.label)!,
                }));
                changed = true;
              }
              if (thread.comments[index] !== comment) changed = true;
              next.set(message, comment);
            }
            if (changed) thread.comments = [...next.values()];
            native.comments = next;
            const state = record.resolved
              ? vscode.CommentThreadState.Resolved
              : vscode.CommentThreadState.Unresolved;
            if (thread.state !== state) thread.state = state;
            const context = record.resolved ? 'formd-resolved' : 'formd-open';
            if (thread.contextValue !== context) thread.contextValue = context;
            if (thread.canReply !== !record.resolved)
              thread.canReply = !record.resolved;
          }
        }
      } catch {
        // The editor binding reports synchronization errors.
      } finally {
        refreshing = false;
      }
    };
    this.documents.set(uri, {
      entry,
      threads,
      refresh,
      unsubscribe: entry.session.subscribe(refresh),
    });
    void refresh();
  }

  async submit({ thread, text }: vscode.CommentReply) {
    const document = this.documents.get(thread.uri.toString());
    const editor = vscode.workspace.textDocuments.find(
      (candidate) => candidate.uri.toString() === thread.uri.toString(),
    );
    if (!document || !editor) return;
    const { entry, threads } = document;
    if (entry.session.status === 'deleted' || entry.session.status === 'error')
      return;
    const id = this.ids.get(thread);
    if (id) {
      entry.session.comments.reply(id, text);
      return;
    }
    const binding = entry.binding;
    if (!binding) return;
    await binding.flush();
    if (
      editor.isClosed ||
      this.documents.get(thread.uri.toString()) !== document
    )
      return;
    const range = thread.range;
    if (!range) return;
    const anchor = captureCommentAnchor(
      binding.viewText,
      editor.offsetAt(range.start),
      editor.offsetAt(range.end),
    );
    const created = entry.session.comments.create(anchor, text);
    this.ids.set(thread, created);
    threads.set(created, { thread });
    void document.refresh();
  }

  resolve(thread: vscode.CommentThread, resolved: boolean) {
    const id = this.ids.get(thread);
    const entry = this.documents.get(thread.uri.toString())?.entry;
    if (
      id &&
      entry &&
      entry.session.status !== 'error' &&
      entry.session.status !== 'deleted'
    )
      entry.session.comments.setResolved(id, resolved);
  }

  delete(comment: vscode.Comment) {
    const target = this.commentIds.get(comment);
    const entry = target && this.documents.get(target.uri)?.entry;
    if (
      target &&
      entry &&
      entry.session.status !== 'error' &&
      entry.session.status !== 'deleted'
    )
      entry.session.comments.deleteMessage(target.id, target.message);
  }

  edit(comment: vscode.Comment, action: 'start' | 'save' | 'cancel') {
    const target = this.commentIds.get(comment);
    const document = target && this.documents.get(target.uri);
    const thread = target && document?.threads.get(target.id)?.thread;
    if (!target || !document || !thread?.comments.includes(comment)) return;
    const session = document.entry.session;
    try {
      if (
        action === 'save' &&
        session.status !== 'error' &&
        session.status !== 'deleted'
      ) {
        const body =
          typeof comment.body === 'string' ? comment.body : comment.body.value;
        session.comments.editMessage(target.id, target.message, body);
      }
    } finally {
      comment.body = target.message.body;
      comment.mode =
        action === 'start'
          ? vscode.CommentMode.Editing
          : vscode.CommentMode.Preview;
      thread.comments = [...thread.comments];
    }
  }

  detach(entry: Entry) {
    const uri = entry.uri.toString();
    const document = this.documents.get(uri);
    if (!document) return;
    this.documents.delete(uri);
    document.unsubscribe();
    for (const { thread } of document.threads.values()) thread.dispose();
  }

  dispose() {
    this.disposed = true;
    for (const { entry } of this.documents.values()) this.detach(entry);
    this.mentionProvider.dispose();
    this.activeEditorListener.dispose();
    this.controller.dispose();
  }
}
