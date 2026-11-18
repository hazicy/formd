import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  check,
  customType,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

const bytea = customType<{ data: Uint8Array; driverData: Buffer }>({
  dataType: () => 'bytea',
  toDriver: (value) => Buffer.from(value),
});

export const foldersTable = pgTable(
  'folders',
  {
    id: uuid('id').primaryKey(),
    parentId: uuid('parent_id').references((): AnyPgColumn => foldersTable.id, {
      onDelete: 'restrict',
    }),
    name: text('name').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    unique('folders_parent_name_key')
      .on(table.parentId, table.name)
      .nullsNotDistinct(),
    check('folders_not_own_parent', sql`${table.parentId} <> ${table.id}`),
  ],
);

export const documentsTable = pgTable(
  'documents',
  {
    id: uuid('id').primaryKey(),
    folderId: uuid('folder_id').references(() => foldersTable.id, {
      onDelete: 'restrict',
    }),
    title: text('title').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
    state: bytea('yjs_state').notNull(),
  },
  (table) => [index('documents_folder_id_idx').on(table.folderId)],
);
