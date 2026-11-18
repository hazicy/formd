import * as vscode from 'vscode';
import * as Y from 'yjs';
import type { DocumentSessions } from './session-manager.js';

const encoder = new TextEncoder();

export function createFileSystemProvider(
  sessions: DocumentSessions,
  onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]>,
): vscode.FileSystemProvider {
  return {
    onDidChangeFile: onDidChangeFile,
    watch: () => new vscode.Disposable(() => {}),
    stat: (uri) => {
      const entry = sessions.getOrCreate(uri);
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
      const entry = sessions.getOrCreate(uri);
      if (entry.binding) return encoder.encode(entry.binding.content);
      if (entry.session.status === 'deleted')
        throw vscode.FileSystemError.FileNotFound(uri);
      if (!entry.hasDraft) await sessions.ready(entry.session);
      // Preserve the exact state returned to VS Code; a remote update may arrive
      // before onDidOpenTextDocument. The binding rebases from this snapshot.
      entry.initialState = Y.encodeStateAsUpdate(entry.session.doc);
      return encoder.encode(entry.session.text.toString());
    },
    writeFile: async (uri, _bytes) => {
      const entry = sessions.getOrCreate(uri);
      if (!entry.binding)
        throw vscode.FileSystemError.Unavailable(
          vscode.l10n.t(
            'This document is not bound to a collaboration session. Reopen it.',
          ),
        );
      await entry.binding.flush();
      // Local content changes already reached Yjs. A save must never replace
      // merged CRDT content using an older, in-flight editor snapshot.
      entry.mtime = Math.max(Date.now(), entry.mtime + 1);
    },
    delete: () => {
      throw vscode.FileSystemError.NoPermissions(
        vscode.l10n.t('Use Formd: Delete Collaborative Document.'),
      );
    },
    rename: () => {
      throw vscode.FileSystemError.NoPermissions(
        vscode.l10n.t('Use Formd: Rename Document.'),
      );
    },
  };
}
