import { pgTable, text } from 'drizzle-orm/pg-core';

export const notesTable = pgTable('notes', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  state: text('state').notNull(),
});
