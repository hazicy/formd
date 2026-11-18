import { resolve } from 'node:path';
import { createTypoServer } from './server.js';
const port = Number(process.env.PORT || 3001);
const origins = (
  process.env.ALLOWED_ORIGINS || 'http://localhost:5173,http://127.0.0.1:5173'
).split(',');
const instance = createTypoServer(
  resolve(process.env.DATA_DIR || 'data'),
  origins,
);
instance.server.listen(port, process.env.HOST || '127.0.0.1', () =>
  console.log(`Formd API: http://localhost:${port}`),
);
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => {
    void instance.close().then(() => process.exit(0));
  });
