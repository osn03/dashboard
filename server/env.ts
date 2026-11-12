import { existsSync } from 'node:fs';

if (existsSync('.env')) process.loadEnvFile('.env');

const e = process.env;
export const config = {
  port: Number(e.PORT ?? 8787),
  host: e.HOST ?? '127.0.0.1',
  databasePath: e.DATABASE_PATH ?? './data/dashboard.db',
  cookieSecure: e.COOKIE_SECURE === 'true',
  encryptionKey: e.APP_ENCRYPTION_KEY ?? '',
  demo: e.DEMO_MODE === 'true',
  intervals: { athleteId: (e.INTERVALS_ATHLETE_ID ?? '').trim(), apiKey: (e.INTERVALS_API_KEY ?? '').trim(), syncMinutes: Math.max(5, Number(e.INTERVALS_SYNC_MINUTES ?? 30)) },
  anthropic: { apiKey: (e.ANTHROPIC_API_KEY ?? '').trim(), model: (e.ANTHROPIC_MODEL ?? '').trim() || 'claude-opus-5-5' },
  claudeCode: { timeoutSeconds: Math.min(900, Math.max(30, Number(e.CLAUDE_CODE_TIMEOUT_SECONDS ?? 240))) },
  openai: { apiKey: (e.OPENAI_API_KEY ?? '').trim(), model: (e.OPENAI_MODEL ?? '').trim() || 'gpt-6.1-sol' },
  google: {
    clientId: e.GOOGLE_CLIENT_ID ?? '',
    clientSecret: e.GOOGLE_CLIENT_SECRET ?? '',
    redirectUri: e.GOOGLE_REDIRECT_URI ?? `http://127.0.0.1:${Number(e.PORT ?? 8787)}/api/google/callback`,
    pkce: e.GOOGLE_PKCE !== 'false',
    syncMinutes: Math.max(1, Number(e.GOOGLE_SYNC_MINUTES ?? 5)),
  },
};
