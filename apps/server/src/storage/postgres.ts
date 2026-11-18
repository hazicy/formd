import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { documentsTable, foldersTable } from './schema.js';
import { StorageConflict, validateFolder, type NoteStore } from './index.js';

function datesToIso<T extends { createdAt: Date; updatedAt: Date }>(row: T) {
  const { createdAt, updatedAt, ...fields } = row;
  return {
    ...fields,
    createdAt: createdAt.toISOString(),
    updatedAt: updatedAt.toISOString(),
  };
}

function datesToPg<T extends { createdAt: string; updatedAt: string }>(row: T) {
  const { createdAt, updatedAt, ...fields } = row;
  return {
    ...fields,
    createdAt: new Date(createdAt),
    updatedAt: new Date(updatedAt),
  };
}

function isForeignKeyViolation(error: unknown): boolean {
  return (
    error instanceof Error &&
    (('code' in error && error.code === '23503') ||
      isForeignKeyViolation(error.cause))
  );
}

export function createPostgresNoteStore(connectionString: string): NoteStore {
  const pool = new pg.Pool({ connectionString, connectionTimeoutMillis: 5000 });
  pool.on('error', (error) =>
    console.error('Formd: PostgreSQL 连接异常', error),
  );
  const db = drizzle(pool);
  type FolderTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

  function writeFolders<T>(operation: (tx: FolderTransaction) => Promise<T>) {
    return db.transaction(
      async (tx) => {
        // Serialize structural writes so a concurrent move cannot invalidate the cycle check.
        await tx.execute(sql`lock table folders in share row exclusive mode`);
        return operation(tx);
      },
      { isolationLevel: 'read committed' },
    );
  }
  return {
    async load() {
      return (await db.select().from(documentsTable)).map(datesToIso);
    },
    async upsert(note) {
      const row = datesToPg(note);
      const { title, updatedAt, state, folderId } = row;
      try {
        await db.insert(documentsTable).values(row).onConflictDoUpdate({
          target: documentsTable.id,
          set: { title, updatedAt, state, folderId },
        });
      } catch (error) {
        if (isForeignKeyViolation(error))
          throw new StorageConflict('文件夹不存在', 404);
        throw error;
      }
    },
    async delete(id) {
      await db.delete(documentsTable).where(eq(documentsTable.id, id));
    },
    async listFolders() {
      return (
        await db.select().from(foldersTable).orderBy(foldersTable.name)
      ).map(datesToIso);
    },
    createFolder(folder) {
      return writeFolders(async (tx) => {
        validateFolder(
          (await tx.select().from(foldersTable)).map(datesToIso),
          folder,
        );
        await tx.insert(foldersTable).values(datesToPg(folder));
        return folder;
      });
    },
    updateFolder(id, changes) {
      return writeFolders(async (tx) => {
        const folders = (await tx.select().from(foldersTable)).map(datesToIso);
        const previous = folders.find((entry) => entry.id === id);
        if (!previous) throw new StorageConflict('文件夹不存在', 404);
        const folder = {
          ...previous,
          ...changes,
          updatedAt: new Date().toISOString(),
        };
        validateFolder(folders, folder);
        await tx
          .update(foldersTable)
          .set(datesToPg(folder))
          .where(eq(foldersTable.id, id));
        return folder;
      });
    },
    async deleteFolder(id) {
      try {
        await writeFolders(async (tx) => {
          const deleted = await tx
            .delete(foldersTable)
            .where(eq(foldersTable.id, id))
            .returning({ id: foldersTable.id });
          if (!deleted.length) throw new StorageConflict('文件夹不存在', 404);
        });
      } catch (error) {
        if (isForeignKeyViolation(error))
          throw new StorageConflict('只能删除空文件夹');
        throw error;
      }
    },
    close: () => pool.end(),
  };
}
