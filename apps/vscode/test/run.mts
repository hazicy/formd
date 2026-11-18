import { runTests } from '@vscode/test-electron';
import { createFormdServer } from '../../server/src/server.js';
import { createMemoryNoteStore } from '../../server/test/memory-store.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import * as Y from 'yjs';

const root = resolve(import.meta.dirname, '../../..');
const temp = mkdtempSync(join(tmpdir(), 'formd-vscode-test-'));
const webUrl = 'http://127.0.0.1:5175';
async function fixtureServer(content: string) {
  const store = createMemoryNoteStore();
  const doc = new Y.Doc();
  doc.getText('content').insert(0, content);
  const now = new Date().toISOString();
  await store.upsert({
    id: 'same-note-id',
    title: 'Server identity',
    folderId: null,
    createdAt: now,
    updatedAt: now,
    state: Y.encodeStateAsUpdate(doc),
  });
  doc.destroy();
  const instance = await createFormdServer(store, [webUrl]);
  await new Promise<void>((resolve) =>
    instance.server.listen(0, '127.0.0.1', resolve),
  );
  const port = (instance.server.address() as { port: number }).port;
  return { ...instance, url: `http://127.0.0.1:${port}` };
}
const server = await fixtureServer('First server');
const secondServer = await fixtureServer('Second server');
const apiUrl = server.url;
const require = createRequire(resolve(root, 'apps/web/package.json'));
const vitePath = join(
  dirname(require.resolve('vite/package.json')),
  'bin/vite.js',
);
const web = spawn(
  process.execPath,
  [vitePath, '--host', '127.0.0.1', '--port', '5175'],
  {
    cwd: join(root, 'apps/web'),
    env: { ...process.env, VITE_API_URL: apiUrl },
    stdio: 'inherit',
  },
);
try {
  const deadline = Date.now() + 20000;
  while (true) {
    try {
      if ((await fetch(webUrl)).ok) break;
    } catch {
      /* wait for Vite */
    }
    if (Date.now() > deadline || web.exitCode !== null)
      throw new Error('Test Vite server failed to start');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await runTests({
    vscodeExecutablePath: process.env.VSCODE_EXECUTABLE_PATH,
    extensionDevelopmentPath: join(root, 'apps/vscode'),
    extensionTestsPath: join(root, 'apps/vscode/dist/test.cjs'),
    extensionTestsEnv: {
      FORMD_TEST_API_URL: apiUrl,
      FORMD_TEST_SECOND_API_URL: secondServer.url,
      FORMD_TEST_WEB_URL: webUrl,
      PLAYWRIGHT_CHANNEL: process.env.PLAYWRIGHT_CHANNEL || '',
    },
    launchArgs: [
      '--user-data-dir',
      join(temp, 'user-data'),
      '--extensions-dir',
      join(temp, 'extensions'),
      '--disable-extensions',
      '--disable-workspace-trust',
      '--skip-welcome',
      '--skip-release-notes',
      '--locale',
      process.env.VSCODE_TEST_LOCALE || 'en',
      '--no-sandbox',
    ],
  });
} finally {
  web.kill('SIGTERM');
  await Promise.all([server.close(), secondServer.close()]);
  rmSync(temp, { recursive: true, force: true });
}
