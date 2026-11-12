import { createApp, type AppOptions } from '../server/app';
import { openDb, type DB } from '../server/db';
import type { GoogleService } from '../server/google/service';
import type { IntervalsService } from '../server/intervals';

export interface TestClient {
  db: DB;
  req: (method: string, path: string, body?: unknown, opts?: { headers?: Record<string, string>; noAuth?: boolean; signal?: AbortSignal }) => Promise<{ status: number; json: any; text: string }>;
}

/** In-process API client against a fresh database (in-memory unless a path is given). */
export async function makeClient(
  dbPath = ':memory:',
  signIn = true,
  google?: (db: DB) => GoogleService,
  intervals?: (db: DB) => IntervalsService,
  extra: (db: DB) => Partial<AppOptions> = () => ({}),
): Promise<TestClient> {
  const db = openDb(dbPath);
  const app = createApp({ db, cookieSecure: false, google: google?.(db), intervals: intervals?.(db), ...extra(db) });
  let cookie = '';
  const req: TestClient['req'] = async (method, path, body, opts = {}) => {
    const res = await app.request(path, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-requested-with': 'dashboard',
        ...(cookie && !opts.noAuth ? { cookie } : {}),
        ...opts.headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: opts.signal,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* not JSON (e.g. an event stream) */
    }
    return { status: res.status, json, text };
  };
  if (signIn) {
    const me = await req('GET', '/api/auth/me');
    const r = me.json.needsSetup
      ? await req('POST', '/api/auth/setup', { username: 'me', password: 'correct horse battery' })
      : await req('POST', '/api/auth/login', { username: 'me', password: 'correct horse battery' });
    if (r.status !== 200) throw new Error(`sign-in failed: ${r.status}`);
  }
  return { db, req };
}
