import * as vscode from 'vscode';
import { DocumentSessions } from './documents/session-manager.js';

const connectionLabels = () =>
  ({
    connecting: [
      vscode.l10n.t('$(sync) Formd Connecting'),
      vscode.l10n.t('Connecting to the collaboration server.'),
    ],
    offline: [
      vscode.l10n.t('$(cloud-offline) Formd Offline'),
      vscode.l10n.t('Waiting to reconnect to the collaboration server.'),
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

const persistenceLabels = () =>
  ({
    saving: [
      vscode.l10n.t('$(sync) Formd Saving'),
      vscode.l10n.t('Waiting for the server to confirm persistence.'),
    ],
    saved: [
      vscode.l10n.t('$(check) Formd Synced'),
      vscode.l10n.t('The server confirmed your latest changes.'),
    ],
    failed: [
      vscode.l10n.t('$(warning) Formd Save Failed'),
      vscode.l10n.t('Click to retry saving your changes to the server.'),
    ],
  }) as const;

export function createConnectionStatus(sessions: DocumentSessions) {
  const item = vscode.window.createStatusBarItem(
    'formd.connection',
    vscode.StatusBarAlignment.Left,
    100,
  );
  item.name = vscode.l10n.t('Formd Collaboration Connection');
  function update() {
    const uri = vscode.window.activeTextEditor?.document.uri;
    const entry = uri?.scheme === 'formd' ? sessions.getByUri(uri) : undefined;
    if (!entry) {
      item.hide();
      return;
    }
    const { status, persistenceStatus } = entry.session;
    [item.text, item.tooltip] =
      status === 'connected'
        ? persistenceLabels()[persistenceStatus]
        : connectionLabels()[status];
    if (status === 'offline' && entry.draft.available) {
      item.text = vscode.l10n.t('$(cloud-offline) Formd Offline Draft');
      item.tooltip = vscode.l10n.t(
        'A local draft is available while waiting to reconnect.',
      );
    }
    item.command =
      status === 'connected' && persistenceStatus === 'failed'
        ? 'formd.retrySync'
        : undefined;
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
