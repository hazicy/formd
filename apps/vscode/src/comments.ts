import * as vscode from 'vscode';
import {
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
  messages?: CommentMessage[];
}

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
  private disposed = false;

  constructor() {
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
    this.controller.options = {
      placeHolder: vscode.l10n.t('Write a Formd comment'),
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
          for (const record of entry.session.comments.list()) {
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
            if (
              !native.messages ||
              native.messages.length !== record.messages.length ||
              native.messages.some(
                (message, index) => message !== record.messages[index],
              )
            ) {
              thread.comments = record.messages.map((message) => ({
                body: message.body,
                mode: vscode.CommentMode.Preview,
                author: { name: message.author },
                timestamp: new Date(message.createdAt),
              }));
              native.messages = record.messages;
            }
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
    this.controller.dispose();
  }
}
