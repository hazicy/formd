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
      command: 'pnpm run dev:server',
      url: 'http://127.0.0.1:3002/api/health',
      env: {
        PORT: '3002',
        DATA_DIR: '../../.tmp/e2e-data',
        ALLOWED_ORIGINS: 'http://127.0.0.1:5174',
      },
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
