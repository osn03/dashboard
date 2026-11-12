import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync } from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk';
import { dirname, join, resolve } from 'node:path';
import { createApp } from './app';
import { AssistantService, type Llm } from './assistant';
import { makeCipher, type Cipher } from './crypto';
import { openDb } from './db';
import { DEMO_USER, seedDemo } from './demo';
import { config } from './env';
import { GoogleClient } from './google/client';
import { GoogleService } from './google/service';
import { claudeCodeStatus } from './claudeCode';
import { IntervalsClient, IntervalsService } from './intervals';
import { openAiLlm } from './openaiLlm';

// Demo mode (`npm run demo`): its own database file and port, and no outside connections.
const demo = config.demo || process.argv.includes('--demo');
const databasePath = demo ? (process.env.DEMO_DATABASE_PATH ?? './data/demo.db') : config.databasePath;
const port = demo ? Number(process.env.DEMO_PORT ?? 8788) : config.port;
const url = `http://${config.host === '0.0.0.0' ? '127.0.0.1' : config.host}:${port}`;

// --log (used by the windowless launcher): what a terminal would show goes to data/server.log.
if (process.argv.includes('--log')) {
  mkdirSync('data', { recursive: true });
  const file = createWriteStream('data/server.log', { flags: 'a' });
  const write = (level: string) => (...args: unknown[]) => void file.write(`${new Date().toISOString()} ${level} ${args.map(String).join(' ')}\n`);
  console.log = write('info');
  console.warn = write('warn');
  console.error = write('error');
  process.on('uncaughtException', (e) => {
    file.write(`${new Date().toISOString()} fatal ${e.stack ?? e}\n`, () => process.exit(1));
  });
}

/** Opens the dashboard in the default browser. No shell string is built from user input. */
function openBrowser() {
  const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  spawn(cmd, args, { stdio: 'ignore', windowsHide: true, detached: process.platform !== 'win32' }).unref();
}

// --open (launcher): if the dashboard is already running, just show it and stop here -
// before the database is opened, so two servers never work on it at once.
const openAfterStart = process.argv.includes('--open');
if (openAfterStart) {
  const running = await fetch(`${url}/api/auth/me`, { signal: AbortSignal.timeout(1500) }).then((r) => r.ok, () => false);
  if (running) {
    openBrowser();
    await new Promise((r) => setTimeout(r, 300));
    process.exit(0);
  }
}
const db = openDb(databasePath);
if (demo) seedDemo(db);

let cipher: Cipher | null = null;
try {
  cipher = makeCipher(config.encryptionKey);
} catch (e) {
  console.warn(`[config] ${(e as Error).message} Integrations are disabled until it is set.`);
}
const googleConfigured = !demo && !!(config.google.clientId && config.google.clientSecret);
const google = new GoogleService(db, googleConfigured ? new GoogleClient(config.google) : null, demo ? null : cipher);

const intervalsConfigured = !demo && !!(config.intervals.athleteId && config.intervals.apiKey);
const intervals = new IntervalsService(db, intervalsConfigured ? new IntervalsClient(config.intervals) : null);

let llm: Llm | null = null;
if (!demo && config.anthropic.apiKey) {
  const anthropic = new Anthropic({ apiKey: config.anthropic.apiKey });
  llm = { create: (params) => anthropic.beta.messages.create(params) };
}
let chatgpt: { llm: Llm; model: string } | null = null;
if (!demo && config.openai.apiKey) {
  const client = new OpenAI({ apiKey: config.openai.apiKey });
  chatgpt = { llm: openAiLlm({ create: (params) => client.responses.create(params) }), model: config.openai.model };
}
// Claude Code with the user's own subscription sign-in. Runs only on this machine.
const claudeCode = demo
  ? null
  : {
      sdk: { query, tool, createSdkMcpServer },
      status: () => claudeCodeStatus(),
      cwd: resolve(join(dirname(databasePath), 'assistant-sandbox')), // an empty folder; the assistant has no file tools anyway
      timeoutMs: config.claudeCode.timeoutSeconds * 1000,
    };
const assistant = new AssistantService(db, llm, config.anthropic.model, google, intervals, () => new Date(), demo, chatgpt, config.openai.model, claudeCode);

// Started by the launcher (Dashboard.vbs): stop when the last dashboard tab has been closed.
const exitWithBrowser = process.argv.includes('--exit-with-browser');
const graceMs = Math.max(2, Number(process.env.EXIT_GRACE_SECONDS ?? 20)) * 1000;
let tabs = 0;
let exitTimer: NodeJS.Timeout | null = null;
const armExit = (ms: number) => {
  if (!exitWithBrowser) return;
  if (exitTimer) clearTimeout(exitTimer);
  exitTimer = setTimeout(() => {
    if (tabs === 0) {
      console.log(`[${new Date().toISOString()}] No dashboard tab open - stopping.`);
      shutdown();
    }
  }, ms);
};
const presence = (delta: 1 | -1) => {
  tabs = Math.max(0, tabs + delta);
  if (tabs > 0 && exitTimer) {
    clearTimeout(exitTimer);
    exitTimer = null;
  }
  // The grace period covers reloads and moving between tabs.
  if (tabs === 0) armExit(graceMs);
};

const app = createApp({ db, cookieSecure: config.cookieSecure, google, intervals, assistant, demo, presence, bindHost: config.host });

// Automatic background sync. Failures are stored and shown in the UI, never thrown here.
const timers = [
  setInterval(() => {
    google.syncAll().catch((e) => console.error(`[google] sync failed: ${(e as Error).name}`));
  }, config.google.syncMinutes * 60_000),
  setInterval(() => {
    intervals.sync().catch(() => console.error('[intervals] import failed'));
  }, config.intervals.syncMinutes * 60_000),
];
google.syncAll().catch((e) => console.error(`[google] startup sync failed: ${(e as Error).name}`));
intervals.sync().catch(() => console.error('[intervals] startup import failed'));

// Serve the built frontend when it exists (production / `npm start`).
if (existsSync('web/dist/index.html')) {
  const index = readFileSync('web/dist/index.html', 'utf8');
  app.use('/*', serveStatic({ root: './web/dist' }));
  app.get('*', (c) => c.html(index));
}

const server = serve({ fetch: app.fetch, port, hostname: config.host }, (info) => {
  console.log(`${demo ? 'DEMO MODE (sample data, separate database) - ' : ''}listening on http://${config.host}:${info.port}`);
  if (demo) console.log(`Demo sign-in: ${DEMO_USER.username} / ${DEMO_USER.password}`);
  if (openAfterStart) openBrowser();
});

function shutdown() {
  timers.forEach(clearInterval);
  server.close();
  db.close();
  process.exit(0);
}
armExit(Math.max(graceMs, 120_000)); // if no browser ever connects, do not linger
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
