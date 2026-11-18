import * as vscode from 'vscode';
import { VscodeBinding } from '@formd/y-vscode';
import type { NoteSession, FormdClient } from '@formd/client';
import { SessionDraft, type DraftStore } from './draft-store.js';

import {
  documentKeyString,
  keyFromUri,
  type DocumentKey,
} from './document-key.js';

interface Entry {
  key: DocumentKey;
  session: NoteSession;
  uri: vscode.Uri;
  mtime: number;
  draft: SessionDraft;
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
    private readonly client: (server: string) => FormdClient,
    private readonly drafts: DraftStore,
    private readonly output: vscode.OutputChannel,
    private readonly report: (error: unknown) => void,
    private readonly onAttach: (entry: Entry) => void,
    private readonly onDetach: (entry: Entry) => void,
  ) {}

  get(key: DocumentKey) {
    return this.entries.get(documentKeyString(key));
  }

  getByUri(uri: vscode.Uri) {
    const key = keyFromUri(uri);
    return key && this.get(key);
  }

  values() {
    return this.entries.values();
  }

  getOrCreate(uri: vscode.Uri): Entry {
    const key = keyFromUri(uri);
    if (!key) throw vscode.FileSystemError.FileNotFound(uri);
    const existing = this.get(key);
    if (existing) {
      if (existing.uri.toString() !== uri.toString())
        throw vscode.FileSystemError.FileExists(existing.uri);
      return existing;
    }
    const session = this.client(key.server).connect(key.noteId);
    const draft = new SessionDraft(
      this.drafts,
      key,
      session,
      uri.path.split('/').at(-1) ?? '',
      () => this.changed.fire(),
      (error, operation) =>
        this.report(
          new Error(
            operation === 'restore'
              ? vscode.l10n.t('Could not restore the Formd local draft.')
              : vscode.l10n.t(
                  'Could not save the Formd local draft. Copy the current text as a backup.',
                ),
            { cause: error },
          ),
        ),
    );
    const entry: Entry = {
      key,
      session,
      uri,
      mtime: Date.now(),
      draft,
      unsubscribe: () => {},
    };
    this.entries.set(documentKeyString(key), entry);
    let status = session.status;
    let persistence = session.persistenceStatus;
    const unsubscribeStatus = session.subscribe(() => {
      if (
        session.status === status &&
        session.persistenceStatus === persistence
      )
        return;
      status = session.status;
      persistence = session.persistenceStatus;
      if (status === 'deleted') {
        entry.draft.flush();
        entry.binding?.dispose();
        entry.binding = undefined;
        this.deleted.fire(entry.uri);
      }
      this.changed.fire();
      // Bound editors consume Y.Text deltas directly. File-change notifications
      // here would invoke VS Code's disk-conflict path for unsaved live input.
    });
    entry.unsubscribe = unsubscribeStatus;
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
    if (!keyFromUri(document.uri)) return;
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
    const entry = this.getByUri(document.uri);
    if (!entry || entry.uri.toString() !== document.uri.toString()) return;
    try {
      await entry.binding?.flush();
    } catch (error) {
      this.output.appendLine(String(error));
    }
    if (
      this.get(entry.key) !== entry ||
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
    entry.draft.dispose();
    this.entries.delete(documentKeyString(entry.key));
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
