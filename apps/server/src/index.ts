import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { createPostgresNoteStore } from './storage/postgres.js';
import { createFormdServer } from './server.js';

if (existsSync('.env')) loadEnvFile('.env');
const { DATABASE_URL } = process.env;
if (!DATABASE_URL) throw new Error('请设置 DATABASE_URL');
const postgres = createPostgresNoteStore(DATABASE_URL);
const port = Number(process.env.PORT || 3001);
const origins = (
  process.env.ALLOWED_ORIGINS || 'http://localhost:5173,http://127.0.0.1:5173'
).split(',');
const instance = await createFormdServer(postgres, origins).catch(
  async (error) => {
    await postgres.close();
    throw error;
  },
);
instance.server.listen(port, process.env.HOST || '127.0.0.1', () =>
  console.log(`Formd API: http://localhost:${port}`),
);
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => {
    void instance.close().catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
  });
