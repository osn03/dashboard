import { defineConfig, devices } from '@playwright/test';
import { rmSync } from 'node:fs';

// End-to-end smoke test: builds the frontend and runs the real server against a
// throwaway database (data/e2e/). No external services are contacted.
const PORT = 8799;
if (!process.env.TEST_WORKER_INDEX) {
  try {
    rmSync('data/e2e', { recursive: true, force: true }); // leftovers from earlier runs
  } catch {
    /* still locked by a previous run; harmless */
  }
}
const DB = `./data/e2e/run-${Date.now()}.db`;
const DEMO_PORT = 8798;

export default defineConfig({
  testDir: 'e2e',
  workers: 1,
  fullyParallel: false,
  reporter: [['list']],
  timeout: 60_000,
  use: { baseURL: `http://127.0.0.1:${PORT}`, timezoneId: 'America/Los_Angeles', trace: 'retain-on-failure' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1360, height: 900 } }, testMatch: /(journey|assistant-layout)\.spec\.ts/ },
    { name: 'mobile', use: { ...devices['Pixel 7'] }, testMatch: /(mobile|assistant-layout)\.spec\.ts/, dependencies: ['desktop'] },
    {
      name: 'demo',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1360, height: 900 }, baseURL: `http://127.0.0.1:${DEMO_PORT}` },
      testMatch: /demo\.spec\.ts/,
      dependencies: ['desktop'],
    },
  ],
  webServer: [
    {
      command: 'npm run build && npm run start',
      url: `http://127.0.0.1:${PORT}/api/auth/me`,
      reuseExistingServer: false,
      timeout: 120_000,
      // Integration credentials are blanked so the test server can never reach real accounts.
      env: {
        PORT: String(PORT), HOST: '127.0.0.1', DATABASE_PATH: DB, COOKIE_SECURE: 'false',
        GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', INTERVALS_API_KEY: '', INTERVALS_ATHLETE_ID: '', OPENAI_API_KEY: '',
        // The assistant test uses the pay-per-use provider with a key that cannot work, so it costs nothing;
        // Claude Code is pointed at a missing file so the tests can never use a real subscription.
        ANTHROPIC_API_KEY: 'sk-ant-invalid-key-for-tests', CLAUDE_CODE_PATH: 'C:\\nonexistent\\claude.exe',
      },
    },
    {
      command: 'npm run demo',
      url: `http://127.0.0.1:${DEMO_PORT}/api/auth/me`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: { DEMO_PORT: String(DEMO_PORT), HOST: '127.0.0.1', DEMO_DATABASE_PATH: `./data/e2e/demo-${Date.now()}.db`, COOKIE_SECURE: 'false' },
    },
  ],
});
