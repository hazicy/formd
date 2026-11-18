import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { notesTable } from './schema.js';
import type { NoteStore, StoredNote } from './index.js';

export function createPostgresNoteStore(connectionString: string) {
  const pool = new pg.Pool({ connectionString, connectionTimeoutMillis: 5000 });
  pool.on('error', (error) =>
    console.error('Formd: PostgreSQL 连接异常', error),
  );
  const db = drizzle(pool);
  return {
    async load() {
      return db.select().from(notesTable);
    },
    async upsert(note: StoredNote) {
      const { title, updatedAt, state } = note;
      await db.insert(notesTable).values(note).onConflictDoUpdate({
        target: notesTable.id,
        set: { title, updatedAt, state },
      });
    },
    async delete(id: string) {
      await db.delete(notesTable).where(eq(notesTable.id, id));
    },
    close: () => pool.end(),
  } satisfies NoteStore;
}
