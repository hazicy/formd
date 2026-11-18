import { getRequestListener } from '@hono/node-server';
import { createServer } from 'node:http';
import { createCollaboration } from './collaboration.js';
import { createHttpApp } from './http.js';
import { createNoteService } from './notes.js';
import type { NoteStore } from './storage/index.js';

export async function createTypoServer(
  store: NoteStore,
  allowedOrigins = ['http://localhost:5173'],
) {
  const collaboration = createCollaboration();
  const notes = await createNoteService(store, collaboration).catch(
    async (error) => {
      await collaboration.close();
      throw error;
    },
  );
  const app = createHttpApp(notes, allowedOrigins);
  const server = createServer(getRequestListener(app.fetch));
  collaboration.bind(server, notes.getDoc, allowedOrigins);

  async function shutdown() {
    try {
      const httpClosed = server.listening
        ? new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          )
        : Promise.resolve();
      await Promise.all([httpClosed, collaboration.close()]);
    } finally {
      await notes.close();
    }
  }

  let shutdownPromise: Promise<void> | undefined;
  const close = () => (shutdownPromise ??= shutdown());
  return { app, server, close };
}
