import * as vscode from 'vscode';
import type { Folder, FormdClient } from '@formd/client';

export function folderPath(
  folders: ReadonlyMap<string, Folder>,
  id: string | null,
) {
  const path: Folder[] = [];
  const seen = new Set<string>();
  while (id && !seen.has(id)) {
    seen.add(id);
    const folder = folders.get(id);
    if (!folder) break;
    path.unshift(folder);
    id = folder.parentId;
  }
  return path;
}

export async function pickDestination(
  client: FormdClient,
  current: string | null,
  movingFolder?: string,
) {
  const folders = await client.listFolders();
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const options: { label: string; id: string | null }[] = [];
  if (current !== null)
    options.push({ label: vscode.l10n.t('Root'), id: null });
  for (const folder of folders) {
    const path = folderPath(byId, folder.id);
    if (folder.id === current || path.some((part) => part.id === movingFolder))
      continue;
    options.push({
      label: path.map((part) => part.name).join(' / '),
      id: folder.id,
    });
  }
  if (!options.length) {
    void vscode.window.showInformationMessage(
      vscode.l10n.t('Formd: No other destination folders are available.'),
    );
    return undefined;
  }
  return vscode.window.showQuickPick(options, {
    placeHolder: vscode.l10n.t('Choose a destination folder'),
  });
}
