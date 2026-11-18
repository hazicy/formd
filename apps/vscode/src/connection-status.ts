import * as vscode from 'vscode';
import { DocumentSessions, documentId } from './documents/session-manager.js';

const connectionLabels = () =>
  ({
    connecting: [
      vscode.l10n.t('$(sync) Formd Connecting'),
      vscode.l10n.t('Connecting to the collaboration server.'),
    ],
    connected: [
      vscode.l10n.t('$(plug) Formd Connected'),
      vscode.l10n.t('The live collaboration connection is active.'),
    ],
    offline: [
      vscode.l10n.t('$(cloud-offline) Formd Offline'),
      vscode.l10n.t(
        'Waiting to reconnect. Local drafts are restored on reopening. The server has not confirmed a save.',
      ),
    ],
    deleted: [
      vscode.l10n.t('$(trash) Formd Document Deleted'),
      vscode.l10n.t('This collaborative document has been deleted.'),
    ],
    error: [
      vscode.l10n.t('$(warning) Formd Sync Error'),
      vscode.l10n.t('Back up the current text and reopen the document.'),
    ],
  }) as const;

export function createConnectionStatus(sessions: DocumentSessions) {
  const item = vscode.window.createStatusBarItem(
    'typo.connection',
    vscode.StatusBarAlignment.Left,
    100,
  );
  item.name = vscode.l10n.t('Formd Collaboration Connection');
  function update() {
    const uri = vscode.window.activeTextEditor?.document.uri;
    const entry =
      uri?.scheme === 'typo' ? sessions.get(documentId(uri)) : undefined;
    if (!entry) {
      item.hide();
      return;
    }
    [item.text, item.tooltip] = connectionLabels()[entry.session.status];
    item.show();
  }
  const subscription = vscode.Disposable.from(
    item,
    sessions.onDidChange(update),
    vscode.window.onDidChangeActiveTextEditor(update),
  );
  update();
  return subscription;
}
