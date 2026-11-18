import type { NoteStore, StoredNote } from '../src/storage/index.js';

export function createMemoryNoteStore(): NoteStore {
  const records = new Map<string, StoredNote>();
  return {
    async load() {
      return [...records.values()].map((note) => ({ ...note }));
    },
    async upsert(note) {
      records.set(note.id, { ...note });
    },
    async delete(id) {
      records.delete(id);
    },
    async close() {},
  };
}
