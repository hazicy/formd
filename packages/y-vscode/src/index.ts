import * as vscode from 'vscode';
import * as Y from 'yjs';
import {
  YEditorBinding,
  type EditorAdapter,
  type EditorChange,
} from './binding.js';
export * from './binding.js';

export class VscodeBinding extends YEditorBinding {
  constructor(
    text: Y.Text,
    document: vscode.TextDocument,
    onError: (error: Error) => void,
    initialState?: Uint8Array,
  ) {
    const adapter: EditorAdapter = {
      snapshot: () => ({ text: document.getText(), version: document.version }),
      onChange: (listener) => {
        const subscription = vscode.workspace.onDidChangeTextDocument(
          (event) => {
            if (
              event.document !== document ||
              event.contentChanges.length === 0
            )
              return;
            // Save/dirty notifications have no content changes or new model revision.
            const change: EditorChange = {
              text: document.getText(),
              version: document.version,
              changes: event.contentChanges,
            };
            listener(change);
          },
        );
        return () => subscription.dispose();
      },
      async applyEdits(changes, version) {
        if (document.isClosed || document.version !== version) return false;
        const edits = changes.map((change) =>
          vscode.TextEdit.replace(
            new vscode.Range(
              document.positionAt(change.rangeOffset),
              document.positionAt(change.rangeOffset + change.rangeLength),
            ),
            change.text,
          ),
        );
        const edit = new vscode.WorkspaceEdit();
        edit.set(document.uri, edits);
        // VS Code captures the current TextDocument version when serializing this
        // WorkspaceEdit and rejects it if the main-thread document advanced.
        return vscode.workspace.applyEdit(edit);
      },
    };
    super(text, adapter, onError, initialState);
  }
}
