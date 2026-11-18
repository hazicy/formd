import type { Folder, Note } from '@typo/core';

export interface StoredNote extends Note {
  state: Uint8Array;
}

export class StorageConflict extends Error {
  constructor(
    message: string,
    readonly status: 404 | 409 = 409,
  ) {
    super(message);
  }
}

export function validateFolder(folders: Folder[], folder: Folder) {
  const byId = new Map(folders.map((entry) => [entry.id, entry]));
  let parentId = folder.parentId;
  while (parentId !== null) {
    if (parentId === folder.id)
      throw new StorageConflict('不能将文件夹移到自身或子文件夹中');
    const parent = byId.get(parentId);
    if (!parent) throw new StorageConflict('父文件夹不存在', 404);
    parentId = parent.parentId;
  }
  if (
    folders.some(
      (entry) =>
        entry.id !== folder.id &&
        entry.parentId === folder.parentId &&
        entry.name === folder.name,
    )
  )
    throw new StorageConflict('同级文件夹已存在同名文件夹');
}

export interface NoteStore {
  load(): Promise<StoredNote[]>;
  upsert(note: StoredNote): Promise<void>;
  delete(id: string): Promise<void>;
  listFolders(): Promise<Folder[]>;
  createFolder(folder: Folder): Promise<Folder>;
  updateFolder(
    id: string,
    changes: Partial<Pick<Folder, 'parentId' | 'name'>>,
  ): Promise<Folder>;
  deleteFolder(id: string): Promise<void>;
  close(): Promise<void>;
}
