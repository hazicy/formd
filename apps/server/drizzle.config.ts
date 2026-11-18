import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { defineConfig } from 'drizzle-kit';

if (existsSync('.env')) loadEnvFile('.env');
const { DATABASE_URL } = process.env;
if (!DATABASE_URL) throw new Error('请设置 DATABASE_URL');

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/storage/schema.ts',
  dbCredentials: { url: DATABASE_URL },
  tablesFilter: ['notes'],
  strict: true,
});
