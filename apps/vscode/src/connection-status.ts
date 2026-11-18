import * as vscode from 'vscode';
import { DocumentSessions, documentId } from './documents/session-manager.js';

const connectionLabels = {
  connecting: ['$(sync) Formd 连接中', '正在连接协作服务器。'],
  connected: ['$(plug) Formd 已连接', '实时协作连接正常。'],
  offline: [
    '$(cloud-offline) Formd 离线',
    '等待重连。本地草稿会在重新打开时恢复；服务器尚未确认保存。',
  ],
  deleted: ['$(trash) Formd 文档已删除', '此协作文档已被删除。'],
  error: ['$(warning) Formd 同步异常', '请备份当前正文，然后重新打开文档。'],
} as const;

export function createConnectionStatus(sessions: DocumentSessions) {
  const item = vscode.window.createStatusBarItem(
    'typo.connection',
    vscode.StatusBarAlignment.Left,
    100,
  );
  item.name = 'Formd 协作连接';
  function update() {
    const uri = vscode.window.activeTextEditor?.document.uri;
    const entry =
      uri?.scheme === 'typo' ? sessions.get(documentId(uri)) : undefined;
    if (!entry) {
      item.hide();
      return;
    }
    [item.text, item.tooltip] = connectionLabels[entry.session.status];
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
