import type { Folder } from '@typo/core';
import {
  StorageConflict,
  validateFolder,
  type NoteStore,
  type StoredNote,
} from '../src/storage/index.js';

export function createMemoryNoteStore(): NoteStore {
  const records = new Map<string, StoredNote>();
  const folders = new Map<string, Folder>();
  return {
    async load() {
      return [...records.values()].map((note) => ({ ...note }));
    },
    async upsert(note) {
      if (note.folderId && !folders.has(note.folderId))
        throw new StorageConflict('文件夹不存在', 404);
      records.set(note.id, { ...note });
    },
    async delete(id) {
      records.delete(id);
    },
    async listFolders() {
      return [...folders.values()];
    },
    async createFolder(folder) {
      validateFolder([...folders.values()], folder);
      folders.set(folder.id, folder);
      return folder;
    },
    async updateFolder(id, changes) {
      const previous = folders.get(id);
      if (!previous) throw new StorageConflict('文件夹不存在', 404);
      const folder = {
        ...previous,
        ...changes,
        updatedAt: new Date().toISOString(),
      };
      validateFolder([...folders.values()], folder);
      folders.set(id, folder);
      return folder;
    },
    async deleteFolder(id) {
      if (!folders.has(id)) throw new StorageConflict('文件夹不存在', 404);
      if (
        [...folders.values()].some((folder) => folder.parentId === id) ||
        [...records.values()].some((note) => note.folderId === id)
      ) {
        throw new StorageConflict('只能删除空文件夹');
      }
      folders.delete(id);
    },
    async close() {},
  };
}
