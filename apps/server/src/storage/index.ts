import { MAX_TITLE_LENGTH, type Folder, type Note } from '@formd/core';

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
  deleteFolder(id: string): Promise<string | null>;
  close(): Promise<void>;
}

export function folderRemoval(folders: Folder[], id: string) {
  const folder = folders.find((entry) => entry.id === id);
  if (!folder) throw new StorageConflict('文件夹不存在', 404);
  const { parentId } = folder;
  const names = new Set(
    // Do not replace the removed folder with a promoted folder of the same name.
    folders.filter((entry) => entry.parentId === parentId)
      .map((entry) => entry.name),
  );
  const children = folders.filter((entry) => entry.parentId === id);
  // Reserve existing child names too, so resolving a collision never renames
  // an otherwise unaffected child.
  const reserved = new Set([...names, ...children.map((child) => child.name)]);
  const moved = children.map((child) => {
    let { name } = child;
    if (names.has(name)) {
      let index = 2;
      do {
        const suffix = ` (${index++})`;
        name = child.name.slice(0, MAX_TITLE_LENGTH - suffix.length) + suffix;
      } while (reserved.has(name));
      reserved.add(name);
    }
    return { ...child, name, parentId, updatedAt: new Date().toISOString() };
  });
  return { parentId, moved };
}
