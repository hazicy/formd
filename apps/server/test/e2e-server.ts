import { createFormdServer } from '../src/server.js';
import { createMemoryNoteStore } from './memory-store.js';

const instance = await createFormdServer(createMemoryNoteStore(), [
  'http://127.0.0.1:5174',
]);
instance.server.listen(3002, '127.0.0.1');
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => {
    void instance.close().catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
  });
