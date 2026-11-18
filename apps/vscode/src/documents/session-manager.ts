import * as vscode from 'vscode';
import { VscodeBinding } from '@formd/y-vscode';
import type { NoteSession, FormdClient } from '@formd/client';
import type { DraftStore } from './draft-store.js';

export function documentId(uri: vscode.Uri) {
  return uri.path.split('/')[1];
}

interface Entry {
  session: NoteSession;
  uri: vscode.Uri;
  mtime: number;
  hasDraft: boolean;
  initialState?: Uint8Array;
  binding?: VscodeBinding;
  unsubscribe: () => void;
}
export class DocumentSessions implements vscode.Disposable {
  private readonly entries = new Map<string, Entry>();
  private readonly changed = new vscode.EventEmitter<void>();
  private readonly deleted = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;
  readonly onDidDelete = this.deleted.event;

  constructor(
    private readonly client: () => FormdClient,
    private readonly drafts: DraftStore,
    private readonly output: vscode.OutputChannel,
    private readonly report: (error: unknown) => void,
    private readonly onAttach: (entry: Entry) => void,
    private readonly onDetach: (entry: Entry) => void,
  ) {}

  get size() {
    return this.entries.size;
  }

  get(id: string) {
    return this.entries.get(id);
  }

  values() {
    return this.entries.values();
  }

  getOrCreate(uri: vscode.Uri): Entry {
    const id = documentId(uri);
    const existing = this.entries.get(id);
    if (existing) return existing;
    const client = this.client();
    const session = client.connect(id);
    let hasDraft = false;
    try {
      hasDraft = this.drafts.restore(client.baseUrl, session);
    } catch (error) {
      this.report(
        new Error(vscode.l10n.t('Could not restore the Formd local draft.'), {
          cause: error,
        }),
      );
    }
    let saveFailed = false;
    const saveDraft = (_update: Uint8Array, origin: unknown) => {
      if (session.isRemoteOrigin(origin)) return;
      try {
        this.drafts.save(client.baseUrl, session);
        entry.hasDraft = true;
        saveFailed = false;
      } catch (error) {
        if (!saveFailed) {
          saveFailed = true;
          this.output.appendLine(String(error));
          this.report(
            new Error(
              vscode.l10n.t(
                'Could not save the Formd local draft. Copy the current text as a backup.',
              ),
            ),
          );
        }
      }
    };
    const entry: Entry = {
      session,
      uri,
      mtime: Date.now(),
      hasDraft,
      unsubscribe: () => {},
    };
    this.entries.set(id, entry);
    let status = session.status;
    const unsubscribeStatus = session.subscribe(() => {
      if (session.status === status) return;
      status = session.status;
      if (status === 'deleted') {
        entry.binding?.dispose();
        entry.binding = undefined;
        this.deleted.fire(entry.uri);
      }
      this.changed.fire();
      // Bound editors consume Y.Text deltas directly. File-change notifications
      // here would invoke VS Code's disk-conflict path for unsaved live input.
    });
    session.doc.on('update', saveDraft);
    entry.unsubscribe = () => {
      unsubscribeStatus();
      session.doc.off('update', saveDraft);
    };
    return entry;
  }
  async ready(session: NoteSession) {
    if (session.status === 'connected') return;
    if (session.status === 'deleted' || session.status === 'error')
      throw vscode.FileSystemError.Unavailable(
        vscode.l10n.t('The document does not exist or could not be synced.'),
      );
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        stop();
        reject(
          new Error(
            vscode.l10n.t('Connection timed out. Check the Formd server URL.'),
          ),
        );
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
          reject(
            new Error(
              vscode.l10n.t(
                'The document does not exist or could not be synced.',
              ),
            ),
          );
        }
      });
    });
  }
  bind(document: vscode.TextDocument) {
    if (document.uri.scheme !== 'formd') return;
    const entry = this.getOrCreate(document.uri);
    if (entry.binding || entry.session.status === 'deleted') return;
    try {
      entry.binding = new VscodeBinding(
        entry.session.text,
        document,
        (error) => {
          this.output.appendLine(error.stack || error.message);
          void vscode.window.showErrorMessage(
            vscode.l10n.t(
              'Formd live editing paused: {0}. Export your text, then reopen the document.',
              error.message,
            ),
          );
        },
        entry.initialState,
      );
      this.onAttach(entry);
      this.changed.fire();
    } catch (error) {
      this.report(error);
    }
  }

  async close(document: vscode.TextDocument) {
    if (document.uri.scheme !== 'formd') return;
    const id = documentId(document.uri);
    const entry = this.entries.get(id);
    if (!entry) return;
    try {
      await entry.binding?.flush();
    } catch (error) {
      this.output.appendLine(String(error));
    }
    if (
      this.entries.get(id) !== entry ||
      vscode.workspace.textDocuments.some(
        (open) =>
          !open.isClosed && open.uri.toString() === entry.uri.toString(),
      )
    )
      return;
    this.release(entry);
    this.changed.fire();
  }

  private release(entry: Entry) {
    this.entries.delete(entry.session.id);
    this.onDetach(entry);
    entry.binding?.dispose();
    entry.unsubscribe();
    entry.session.destroy();
  }

  dispose() {
    for (const entry of this.entries.values()) this.release(entry);
    this.changed.dispose();
    this.deleted.dispose();
  }
}
