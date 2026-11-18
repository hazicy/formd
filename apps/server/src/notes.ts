import { randomUUID } from 'node:crypto';
import * as Y from 'yjs';
import { normalizeTitle, type Note } from '@formd/core';
import type { NoteStore } from './storage/index.js';

interface NoteEvents {
  onUpdate(id: string, update: Uint8Array, origin: unknown): void;
  onDelete(id: string): void;
}

export async function createNoteService(store: NoteStore, events: NoteEvents) {
  const stored = await store.load();
  const notes = new Map<string, Note>();
  const docs = new Map<string, Y.Doc>();
  const dirty = new Set<string>();
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let pendingWrite = Promise.resolve();
  let closing = false;

  function write<T>(operation: () => Promise<T>) {
    const result = pendingWrite.then(operation);
    pendingWrite = result.then(
      () => {},
      () => {},
    );
    return result;
  }
  function save(note: Note, doc: Y.Doc) {
    return store.upsert({
      ...note,
      state: Y.encodeStateAsUpdate(doc),
    });
  }
  async function flushDirty() {
    for (const id of [...dirty]) {
      dirty.delete(id);
      try {
        await save(notes.get(id)!, docs.get(id)!);
      } catch (error) {
        dirty.add(id);
        throw error;
      }
    }
  }
  function scheduleFlush(delay = 100) {
    if (closing || flushTimer) return;
    flushTimer = setTimeout(() => {
      void write(flushDirty).then(
        () => {
          flushTimer = undefined;
          if (dirty.size) scheduleFlush();
        },
        (error) => {
          flushTimer = undefined;
          console.error('Formd: 保存文档失败', error);
          scheduleFlush(1000);
        },
      );
    }, delay);
  }
  function attach(id: string, doc: Y.Doc) {
    docs.set(id, doc);
    doc.on('update', (update: Uint8Array, origin: unknown) => {
      const note = notes.get(id);
      if (!note) return;
      note.updatedAt = new Date().toISOString();
      events.onUpdate(id, update, origin);
      dirty.add(id);
      scheduleFlush();
    });
  }
  for (const { state, ...note } of stored) {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, state);
    notes.set(note.id, note);
    attach(note.id, doc);
  }
  async function add(title: string, content: string, folderId: string | null) {
    const now = new Date().toISOString();
    const note: Note = {
      id: randomUUID(),
      title: normalizeTitle(title),
      folderId,
      createdAt: now,
      updatedAt: now,
    };
    const doc = new Y.Doc();
    doc.getText('content').insert(0, content);
    try {
      await save(note, doc);
    } catch (error) {
      doc.destroy();
      throw error;
    }
    notes.set(note.id, note);
    attach(note.id, doc);
    return note;
  }
  function update(
    id: string,
    changes: Partial<Pick<Note, 'title' | 'folderId'>>,
  ) {
    return write(async () => {
      const note = notes.get(id);
      if (!note) return undefined;
      const renamed = {
        ...note,
        ...changes,
        title:
          changes.title === undefined
            ? note.title
            : normalizeTitle(changes.title),
        updatedAt: new Date().toISOString(),
      };
      await save(renamed, docs.get(id)!);
      note.title = renamed.title;
      note.folderId = renamed.folderId;
      if (renamed.updatedAt > note.updatedAt)
        note.updatedAt = renamed.updatedAt;
      return note;
    });
  }
  function remove(id: string) {
    return write(async () => {
      if (!notes.has(id)) return false;
      await store.delete(id);
      dirty.delete(id);
      notes.delete(id);
      events.onDelete(id);
      docs.get(id)?.destroy();
      docs.delete(id);
      return true;
    });
  }
  return {
    list: () =>
      [...notes.values()].sort((a, b) =>
        b.updatedAt.localeCompare(a.updatedAt),
      ),
    has: (id: string) => notes.has(id),
    getDoc: (id: string) => docs.get(id),
    create: (title: string, content: string, folderId: string | null) =>
      write(() => add(title, content, folderId)),
    update,
    remove,
    async close() {
      closing = true;
      clearTimeout(flushTimer);
      try {
        await write(flushDirty);
      } finally {
        for (const doc of docs.values()) doc.destroy();
        await store.close();
      }
    },
  };
}

export type NoteService = Pick<
  Awaited<ReturnType<typeof createNoteService>>,
  'list' | 'has' | 'create' | 'update' | 'remove'
>;
