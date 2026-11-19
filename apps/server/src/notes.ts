import { randomUUID } from 'node:crypto';
import * as Y from 'yjs';
import { NoteComments, type CommentInboxItem } from '@formd/client';
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
  const pendingSaves = new Map<string, Map<object, (saved: boolean) => void>>();
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
    const failures: unknown[] = [];
    for (const id of [...pendingSaves.keys()]) {
      const acknowledgements = pendingSaves.get(id)!;
      // Edits received during this write belong to a new snapshot.
      pendingSaves.delete(id);
      let saved = false;
      try {
        await save(notes.get(id)!, docs.get(id)!);
        saved = true;
      } catch (error) {
        queueSave(id);
        failures.push(error);
      }
      for (const reply of acknowledgements.values()) reply(saved);
    }
    if (failures.length) throw new AggregateError(failures);
  }
  function scheduleFlush(delay = 100) {
    if (closing || flushTimer) return;
    flushTimer = setTimeout(() => {
      void write(flushDirty).then(
        () => {
          flushTimer = undefined;
          if (pendingSaves.size) scheduleFlush();
        },
        (error) => {
          flushTimer = undefined;
          console.error('Formd: 保存文档失败', error);
          scheduleFlush(1000);
        },
      );
    }, delay);
  }
  function queueSave(id: string) {
    let batch = pendingSaves.get(id);
    if (!batch) {
      batch = new Map();
      pendingSaves.set(id, batch);
    }
    scheduleFlush();
    return batch;
  }
  function confirmPersistence(
    id: string,
    connection: object,
    reply: (saved: boolean) => void,
  ) {
    if (!notes.has(id)) return;
    queueSave(id).set(connection, reply);
  }
  function attach(id: string, doc: Y.Doc) {
    docs.set(id, doc);
    doc.on('update', (update: Uint8Array, origin: unknown) => {
      const note = notes.get(id);
      if (!note) return;
      note.updatedAt = new Date().toISOString();
      events.onUpdate(id, update, origin);
      queueSave(id);
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
      pendingSaves.delete(id);
      notes.delete(id);
      events.onDelete(id);
      docs.get(id)?.destroy();
      docs.delete(id);
      return true;
    });
  }
  return {
    commentInbox(name: string): CommentInboxItem[] {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const mention = new RegExp(
        `(?<![a-zA-Z0-9_.+@])@${escaped}(?![\\p{L}\\p{N}_])`,
        'u',
      );
      const items: CommentInboxItem[] = [];
      for (const [id, doc] of docs) {
        const note = notes.get(id);
        if (!note) continue;
        for (const thread of new NoteComments(doc, () => '').list()) {
          if (thread.resolved) continue;
          const latest = thread.messages.at(-1)!;
          let mentioned: (typeof thread.messages)[number] | undefined;
          for (const message of thread.messages) {
            if (message.author.trim() !== name && mention.test(message.body)) {
              mentioned = message;
            }
          }
          const reply =
            thread.messages[0].author.trim() === name &&
            latest.author.trim() !== name;
          if (!mentioned && !reply) continue;
          const useReply =
            reply && (!mentioned || latest.createdAt > mentioned.createdAt);
          items.push({
            noteId: id,
            noteTitle: note.title,
            threadId: thread.id,
            anchor: thread.anchor,
            reason: useReply ? 'reply' : 'mention',
            message: useReply ? latest : mentioned!,
          });
        }
      }
      return items.sort((a, b) => b.message.createdAt - a.message.createdAt);
    },
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
    deleteFolder: (id: string) =>
      write(async () => {
        const parentId = await store.deleteFolder(id);
        for (const note of notes.values()) {
          if (note.folderId === id) note.folderId = parentId;
        }
        return parentId;
      }),
    confirmPersistence,
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
  'list' | 'has' | 'create' | 'update' | 'remove' | 'commentInbox' | 'deleteFolder'
>;
