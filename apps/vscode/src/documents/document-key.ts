import * as vscode from 'vscode';

export interface DocumentKey {
  server: string;
  noteId: string;
}

export function documentKeyString({ server, noteId }: DocumentKey) {
  return JSON.stringify([server, noteId]);
}

export function documentUri(key: DocumentKey, filename: string) {
  return vscode.Uri.from({
    scheme: 'formd',
    authority: Buffer.from(key.server).toString('hex'),
    path: `/${key.noteId}/${filename}`,
  });
}

export function keyFromUri(uri: vscode.Uri): DocumentKey | undefined {
  const [, noteId] = uri.path.split('/');
  const server = Buffer.from(uri.authority, 'hex').toString();
  if (
    uri.scheme !== 'formd' ||
    !/^[a-zA-Z0-9_-]+$/.test(noteId ?? '') ||
    Buffer.from(server).toString('hex') !== uri.authority ||
    !/^https?:\/\//.test(server)
  ) {
    return undefined;
  }
  return { server, noteId };
}
