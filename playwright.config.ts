import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:5174',
    browserName: 'chromium',
    channel: process.env.PLAYWRIGHT_CHANNEL || undefined,
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: 'pnpm exec tsx apps/server/test/e2e-server.ts',
      url: 'http://127.0.0.1:3002/api/health',
      reuseExistingServer: false,
    },
    {
      command: 'pnpm --filter @typo/web run dev --port 5174 --host 127.0.0.1',
      url: 'http://127.0.0.1:5174',
      env: { VITE_API_URL: 'http://127.0.0.1:3002' },
      reuseExistingServer: false,
    },
  ],
});
