// MOCKED integration tests: the app's real Google code runs against FakeGoogle (tests/fakeGoogle.ts).
// These prove the sync/retry/conflict/mirroring logic, NOT that a live Google account works.
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { makeCipher } from '../server/crypto';
import { openDb, migrate, type DB } from '../server/db';
import { GoogleClient } from '../server/google/client';
import { GoogleService } from '../server/google/service';
import { FakeGoogle } from './fakeGoogle';
import { makeClient, type TestClient } from './helpers';

const ME = 'me@example.com';
const OTHER = 'other@example.com';
const HOLIDAYS = 'holidays@group';
const KEY = Buffer.alloc(32, 7).toString('base64');
const NOW = new Date('2026-11-11T10:00:00Z');
const timed = (id: string, start: string, end: string, extra: object = {}) => ({
  id, summary: id, start: { dateTime: start }, end: { dateTime: end }, organizer: { email: ME, self: true }, ...extra,
});
const uid = () => crypto.randomUUID().replaceAll('-', '');

let fake: FakeGoogle;
let c: TestClient;
let svc: GoogleService;
/** The app's own id of the "me" primary calendar. */
let MEC: string;

const newService = (db: DB) => {
  const client = new GoogleClient({ clientId: 'cid', clientSecret: 'csecret', redirectUri: 'http://127.0.0.1:8787/api/google/callback' }, fake.fetch, async () => {});
  svc = new GoogleService(db, client, makeCipher(KEY), () => NOW);
  return svc;
};
/** App id of a calendar, by its Google id and the account that sees it. */
const cid = (googleId: string, account = ME): string =>
  (c.db.prepare('SELECT c.id FROM google_calendars c JOIN google_accounts a ON a.id = c.account_id WHERE c.google_id = ? AND a.label = ?').get(googleId, account) as any).id;
const calRow = (id: string) => c.db.prepare('SELECT * FROM google_calendars WHERE id = ?').get(id) as any;

async function setup(connect = true) {
  fake = new FakeGoogle();
  c = await makeClient(':memory:', true, newService);
  if (connect) {
    await connectAccount();
    MEC = cid(ME);
  }
}
async function connectAccount(code = 'abc') {
  const { json } = await c.req('POST', '/api/google/connect', { returnTo: 'http://127.0.0.1:5173' });
  const state = new URL(json.url).searchParams.get('state')!;
  return c.req('GET', `/api/google/callback?code=${code}&state=${state}`);
}
const status = async () => (await c.req('GET', '/api/google/status')).json;
const events = async (from = '2026-11-01', to = '2026-11-30') => (await c.req('GET', `/api/events?from=${from}&to=${to}`)).json as any[];
const gpath = (calendarId: string, eventId: string) => `/api/google/events/${encodeURIComponent(calendarId)}/${eventId}`;

beforeEach(() => setup());

describe('OAuth connection', () => {
  it('uses minimal scopes, PKCE and offline access; stores only an encrypted refresh token', async () => {
    await setup(false);
    expect((await status()).state).toBe('disconnected');
    const { json } = await c.req('POST', '/api/google/connect', { returnTo: 'http://127.0.0.1:5173' });
    const url = new URL(json.url);
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('scope')!.split(' ').sort()).toEqual([
      'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
      'https://www.googleapis.com/auth/calendar.events',
    ]);
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');

    expect((await c.req('GET', `/api/google/callback?code=abc&state=wrong`)).status).toBe(302);
    expect((await status()).state).toBe('disconnected');

    await c.req('GET', `/api/google/callback?code=abc&state=${url.searchParams.get('state')}`);
    const st = await status();
    expect(st.state).toBe('connected');
    expect(st.accounts).toMatchObject([{ label: ME, status: 'connected' }]);
    const mine = st.calendars.find((x: any) => x.summary === 'Me');
    expect(mine).toMatchObject({ selected: true, readOnly: false, isDefault: true, accountLabel: ME, color: '#1a73e8' });
    expect(st.defaultCalendarId).toBe(mine.id);
    expect(st.calendars.find((x: any) => x.summary === 'Holidays')).toMatchObject({ selected: false, readOnly: true });
    expect(new Set(st.calendars.map((x: any) => x.color)).size).toBe(st.calendars.length); // distinct colours

    const raw = c.db.prepare('SELECT refresh_token_enc FROM google_accounts').get() as any;
    expect(raw.refresh_token_enc).toMatch(/^v1:/);
    expect(raw.refresh_token_enc).not.toContain('rt-secret');
    expect(fake.tokenRequests[0].get('code_verifier')).toBeTruthy();
    expect(JSON.stringify((await c.req('GET', '/api/export')).json)).not.toContain('rt-secret');
  });

  it('the OAuth callback and all Google routes require a signed-in session', async () => {
    expect((await c.req('GET', '/api/google/callback?code=x&state=y', undefined, { noAuth: true })).status).toBe(401);
    expect((await c.req('GET', '/api/google/status', undefined, { noAuth: true })).status).toBe(401);
  });

  it('reports "not configured" when no OAuth client is set, and the rest of the app still works', async () => {
    const plain = await makeClient(':memory:', true, (db) => new GoogleService(db, null, null));
    expect((await plain.req('GET', '/api/google/status')).json).toMatchObject({ state: 'not_configured', canConnect: false });
    expect((await plain.req('POST', '/api/google/connect', { returnTo: '' })).status).toBe(409);
    expect((await plain.req('POST', '/api/tasks', { title: 'Still works' })).status).toBe(201);
  });

  it('REGRESSION: a sync attempted before any account exists must not block later syncs', async () => {
    await setup(false);
    await svc.syncAll(); // server start-up with nothing connected (returns without awaiting anything)
    expect((await status()).syncing).toBe(false);
    fake.put(ME, timed('a', '2026-11-12T09:00:00+01:00', '2026-11-12T10:00:00+01:00'));
    await connectAccount();
    expect((await status()).syncing).toBe(false);
    expect((await events()).map((e) => e.title)).toEqual(['a']); // the first sync after connecting really ran
    fake.put(ME, timed('b', '2026-11-13T09:00:00+01:00', '2026-11-13T10:00:00+01:00'));
    await svc.syncAll();
    expect(await events()).toHaveLength(2);
    expect(calRow(cid(ME)).last_synced_at).toBeTruthy();
  });

  it('disconnect removes the token and cached events', async () => {
    fake.put(ME, timed('a', '2026-11-12T09:00:00+01:00', '2026-11-12T10:00:00+01:00'));
    await svc.syncAll();
    expect(await events()).toHaveLength(1);
    const acc = (await status()).accounts[0].id;
    const r = (await c.req('POST', `/api/google/accounts/${acc}/disconnect`)).json;
    expect(r.revokedAtGoogle).toBe(true);
    expect(r.status.state).toBe('disconnected');
    expect(await events()).toHaveLength(0);
    expect(c.db.prepare('SELECT COUNT(*) n FROM google_accounts').get()).toEqual({ n: 0 });
  });
});

describe('upgrading an existing installation', () => {
  it('the migration keeps the connected account, calendars, selection, default and cached events', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dash-mig-'));
    try {
      const path = join(dir, 'old.db');
      const old = openDb(path, (f) => f < '003'); // schema as it was before this upgrade
      old.prepare("INSERT INTO tasks (id, title, created_at, updated_at) VALUES ('t1', 'Keep me', 'x', 'x')").run();
      old.prepare("INSERT INTO google_account (id, label, refresh_token_enc, scopes, status, default_calendar_id, connected_at) VALUES (1, ?, 'v1:ENC', 's', 'connected', ?, '2026-11-11T10:48:18.754Z')").run(ME, ME);
      old.prepare("INSERT INTO google_calendars (id, summary, color, access_role, is_primary, selected, sync_token) VALUES (?, 'Me', '#111111', 'owner', 1, 1, 'tok-1')").run(ME);
      old.prepare("INSERT INTO google_calendars (id, summary, access_role) VALUES ('holidays@group', 'Holidays', 'reader')").run();
      old.prepare("INSERT INTO google_events (calendar_id, id, all_day, start_at, end_at, fetched_at) VALUES (?, 'e1', 0, '2026-11-12T08:00:00.000Z', '2026-11-12T09:00:00.000Z', 'x')").run(ME);
      old.close();

      const db = openDb(path); // applies the new migrations
      expect(migrate(db)).toEqual([]); // idempotent
      expect(readdirSync(join(dir, 'backups')).filter((f) => f.startsWith('before-upgrade-'))).toHaveLength(1); // automatic backup
      expect(db.prepare('SELECT id, label, refresh_token_enc, status FROM google_accounts').all()).toEqual([
        { id: 'primary', label: ME, refresh_token_enc: 'v1:ENC', status: 'connected' },
      ]);
      expect(db.prepare('SELECT id, google_id, account_id, selected, is_default, sync_token FROM google_calendars ORDER BY id').all()).toEqual([
        { id: 'holidays@group', google_id: 'holidays@group', account_id: 'primary', selected: 0, is_default: 0, sync_token: null },
        { id: ME, google_id: ME, account_id: 'primary', selected: 1, is_default: 1, sync_token: 'tok-1' },
      ]);
      expect(db.prepare('SELECT COUNT(*) n FROM google_events').get()).toEqual({ n: 1 });
      expect(db.prepare('SELECT title FROM tasks').all()).toEqual([{ title: 'Keep me' }]);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('multiple calendars and accounts', () => {
  it('combines all selected calendars, each with its own colour, source label and sync token', async () => {
    fake.put(ME, timed('mine', '2026-11-12T09:00:00+01:00', '2026-11-12T10:00:00+01:00'));
    fake.put(HOLIDAYS, { id: 'h1', summary: 'Public holiday', start: { date: '2026-11-15' }, end: { date: '2026-11-16' } });
    await svc.syncAll();
    expect((await events()).map((e) => e.title)).toEqual(['mine']); // holidays not selected yet

    const HOL = cid(HOLIDAYS);
    const st = (await c.req('PUT', '/api/google/calendars', { selected: [MEC, HOL], defaultCalendarId: MEC, colors: { [HOL]: '#aa00aa' } })).json;
    expect(st.calendars.filter((x: any) => x.selected)).toHaveLength(2);
    const list = await events();
    expect(list.map((e) => e.title).sort()).toEqual(['Public holiday', 'mine']);
    const h = list.find((e) => e.title === 'Public holiday');
    expect(h).toMatchObject({ source: 'google', google: { readOnly: true, calendarName: 'Holidays', color: '#aa00aa', accountLabel: ME } });
    expect(list.find((e) => e.title === 'mine').google).toMatchObject({ calendarName: 'Me', color: '#1a73e8', readOnly: false });
    expect(calRow(MEC).sync_token).toBeTruthy();
    expect(calRow(HOL).sync_token).toBeTruthy();
    expect(calRow(MEC).sync_token).not.toBe(null);

    // Read-only is enforced on the server, not just in the UI.
    expect((await c.req('PUT', '/api/google/calendars', { selected: [MEC], defaultCalendarId: HOL })).status).toBe(400);
    expect((await c.req('PATCH', gpath(HOL, 'h1'), { title: 'Hacked' })).status).toBe(403);
    expect((await c.req('DELETE', gpath(HOL, 'h1'))).status).toBe(403);
    expect(fake.calls('PATCH')).toHaveLength(0);
    expect(fake.calls('DELETE')).toHaveLength(0);
  });

  it('the same event id in two calendars stays two separate events', async () => {
    const second = cid('blocks@group');
    await c.req('PUT', '/api/google/calendars', { selected: [MEC, second], defaultCalendarId: MEC });
    fake.put(ME, timed('same-id', '2026-11-12T09:00:00+01:00', '2026-11-12T10:00:00+01:00', { summary: 'In Me' }));
    fake.put('blocks@group', timed('same-id', '2026-11-13T09:00:00+01:00', '2026-11-13T10:00:00+01:00', { summary: 'In Blocks' }));
    await svc.syncAll();
    await svc.syncAll();
    expect((await events()).map((e) => e.title).sort()).toEqual(['In Blocks', 'In Me']);
    // Editing one leaves the other alone.
    await c.req('PATCH', gpath(second, 'same-id'), { title: 'Renamed' });
    expect(fake.get('blocks@group', 'same-id').summary).toBe('Renamed');
    expect(fake.get(ME, 'same-id').summary).toBe('In Me');
    // Deselecting one calendar removes only its events and its token.
    await c.req('PUT', '/api/google/calendars', { selected: [MEC], defaultCalendarId: MEC });
    expect((await events()).map((e) => e.title)).toEqual(['In Me']);
    expect(calRow(second).sync_token).toBeNull();
  });

  it('a new event goes to the chosen destination, not necessarily the default', async () => {
    const second = cid('blocks@group');
    await c.req('PUT', '/api/google/calendars', { selected: [MEC, second], defaultCalendarId: MEC });
    const r = await c.req('POST', '/api/google/events', { calendarId: second, clientId: uid(), title: 'Elsewhere', allDay: false, startAt: '2026-11-12T09:00:00.000Z', endAt: '2026-11-12T10:00:00.000Z' });
    expect(r.status).toBe(201);
    expect(fake.list('blocks@group').map((e) => e.summary)).toEqual(['Elsewhere']);
    expect(fake.list(ME)).toHaveLength(0);
    expect((await status()).defaultCalendarId).toBe(MEC);
  });

  it('a second Google account is added alongside the first, with its own token, calendars and sync state', async () => {
    fake.put(ME, timed('personal', '2026-11-12T09:00:00+01:00', '2026-11-12T10:00:00+01:00'));
    fake.put(OTHER, timed('work', '2026-11-12T13:00:00+01:00', '2026-11-12T14:00:00+01:00', { organizer: { email: OTHER, self: true } }));
    fake.put(HOLIDAYS, { id: 'h1', summary: 'Public holiday', start: { date: '2026-11-15' }, end: { date: '2026-11-16' } });
    await connectAccount('second');

    const st = await status();
    expect(st.accounts.map((a: any) => a.label).sort()).toEqual([ME, OTHER]);
    expect(st.defaultCalendarId).toBe(MEC); // adding an account does not move the default
    expect(c.db.prepare('SELECT COUNT(*) n FROM google_accounts').get()).toEqual({ n: 2 });
    expect((await events()).map((e) => [e.title, e.google.accountLabel]).sort()).toEqual([['personal', ME], ['work', OTHER]]);

    // The shared calendar is visible through both accounts as two separate rows; selecting both
    // keeps two caches, and the user can simply untick one to avoid seeing it twice.
    const viaMe = cid(HOLIDAYS, ME);
    const viaOther = cid(HOLIDAYS, OTHER);
    expect(viaMe).not.toBe(viaOther);
    await c.req('PUT', '/api/google/calendars', { selected: [MEC, cid(OTHER, OTHER), viaOther], defaultCalendarId: cid(OTHER, OTHER) });
    expect((await events()).filter((e) => e.title === 'Public holiday')).toHaveLength(1);
    expect(fake.calls('GET', `/calendars/${HOLIDAYS}/events`).every((l) => l.user === 'other')).toBe(true);

    // Writes use the token of the account that owns the destination calendar.
    await c.req('POST', '/api/google/events', { calendarId: cid(OTHER, OTHER), clientId: uid(), title: 'Work thing', allDay: false, startAt: '2026-11-12T09:00:00.000Z', endAt: '2026-11-12T10:00:00.000Z' });
    expect(fake.calls('POST').at(-1)!.user).toBe('other');

    // Signing in again with a known account reconnects it instead of adding a third.
    await connectAccount('second');
    expect(c.db.prepare('SELECT COUNT(*) n FROM google_accounts').get()).toEqual({ n: 2 });

    // One account losing access does not stop the other.
    fake.revoked.add('other');
    (svc as any).access.clear();
    fake.put(ME, timed('later', '2026-11-14T09:00:00+01:00', '2026-11-14T10:00:00+01:00'));
    const r = (await c.req('POST', '/api/google/sync')).json;
    expect(r.ok).toBe(false);
    expect(r.status.accounts.map((a: any) => [a.label, a.status]).sort()).toEqual([[ME, 'connected'], [OTHER, 'revoked']]);
    expect((await events()).map((e) => e.title)).toContain('later');

    // Disconnecting one account leaves the other untouched.
    const otherId = r.status.accounts.find((a: any) => a.label === OTHER).id;
    await c.req('POST', `/api/google/accounts/${otherId}/disconnect`);
    expect((await status()).accounts.map((a: any) => a.label)).toEqual([ME]);
    expect((await events()).every((e) => e.google.accountLabel === ME)).toBe(true);
  });

  it('a Google event can be hidden here (duplicate handling) and shown again', async () => {
    fake.put(ME, timed('run', '2026-11-12T07:00:00+01:00', '2026-11-12T08:00:00+01:00', { summary: 'Easy run' }));
    fake.put(ME, timed('other', '2026-11-12T12:00:00+01:00', '2026-11-12T13:00:00+01:00'));
    await svc.syncAll();
    await c.req('POST', `${gpath(MEC, 'run')}/hide`);
    expect((await events()).map((e) => e.title)).toEqual(['other']);
    await svc.syncAll(); // stays hidden across syncs
    expect((await events()).map((e) => e.title)).toEqual(['other']);
    expect(fake.get(ME, 'run')).toBeDefined(); // nothing was deleted at Google
    const st = await status();
    expect(st.hidden).toMatchObject([{ title: 'Easy run' }]);
    await c.req('POST', '/api/google/unhide', { calendarId: MEC, eventKey: st.hidden[0].eventKey });
    expect(await events()).toHaveLength(2);
  });
});

describe('sync (acceptance 5, 8)', () => {
  it('full sync pages through results, then incremental sync picks up external edits, additions and deletions', async () => {
    fake.pageSize = 2;
    for (let i = 1; i <= 5; i++) fake.put(ME, timed(`e${i}`, `2026-11-1${i}T09:00:00+01:00`, `2026-11-1${i}T10:00:00+01:00`));
    await svc.syncAll();
    expect((await events()).map((e) => e.title).sort()).toEqual(['e1', 'e2', 'e3', 'e4', 'e5']);
    expect(fake.calls('GET', '/events').filter((l) => l.query.get('pageToken')).length).toBeGreaterThanOrEqual(2);

    fake.put(ME, { ...fake.get(ME, 'e1'), summary: 'Renamed in Google' });
    fake.put(ME, timed('e6', '2026-11-20T09:00:00+01:00', '2026-11-20T10:00:00+01:00'));
    fake.remove(ME, 'e2');
    const before = fake.log.length;
    expect((await c.req('POST', '/api/google/sync')).json.ok).toBe(true);
    const incremental = fake.log.slice(before).filter((l) => l.path.endsWith('/events'));
    expect(incremental.every((l) => l.query.get('syncToken') && !l.query.get('timeMin'))).toBe(true);
    expect((await events()).map((e) => e.title).sort()).toEqual(['Renamed in Google', 'e3', 'e4', 'e5', 'e6']);

    // Syncing again with nothing changed must not duplicate anything.
    await svc.syncAll();
    await svc.syncAll();
    expect(await events()).toHaveLength(5);
    expect(c.db.prepare('SELECT COUNT(*) n FROM google_events').get()).toEqual({ n: 5 });
  });

  it('an expired sync token (410) triggers a clean full resync', async () => {
    fake.put(ME, timed('keep', '2026-11-12T09:00:00+01:00', '2026-11-12T10:00:00+01:00'));
    fake.put(ME, timed('gone', '2026-11-13T09:00:00+01:00', '2026-11-13T10:00:00+01:00'));
    await svc.syncAll();
    const token = calRow(MEC).sync_token;
    fake.expiredTokens.add(token);
    fake.remove(ME, 'gone');
    const r = await svc.syncCalendar(MEC);
    expect(r.full).toBe(true);
    expect((await events()).map((e) => e.title)).toEqual(['keep']);
    expect(calRow(MEC).sync_token).not.toBe(token);
  });

  it('a failure half-way through leaves the cache and sync token untouched', async () => {
    fake.put(ME, timed('a', '2026-11-12T09:00:00+01:00', '2026-11-12T10:00:00+01:00'));
    await svc.syncAll();
    const token = calRow(MEC).sync_token;
    fake.put(ME, timed('b', '2026-11-13T09:00:00+01:00', '2026-11-13T10:00:00+01:00'));
    fake.failNext = 99;
    const r = (await c.req('POST', '/api/google/sync')).json;
    expect(r.ok).toBe(false);
    expect(r.status.accounts[0].lastError).toMatch(/503/);
    expect((await events()).map((e) => e.title)).toEqual(['a']); // stale but intact
    expect(calRow(MEC).sync_token).toBe(token);
    fake.failNext = 0;
    const again = (await c.req('POST', '/api/google/sync')).json;
    expect(again.ok).toBe(true);
    expect(again.status.accounts[0].lastError).toBeNull();
    expect(await events()).toHaveLength(2);
  });

  it('all-day events keep their dates; recurring instances keep wall-clock time across the DST change', async () => {
    fake.put(ME, { id: 'trip', summary: 'Trip', start: { date: '2026-11-12' }, end: { date: '2026-11-14' }, organizer: { email: ME } });
    // Weekly 09:00 Europe/Oslo, expanded by Google: +02:00 before 25 Oct 2026, +01:00 after.
    fake.put(ME, timed('w_1', '2026-10-21T09:00:00+02:00', '2026-10-21T10:00:00+02:00', { recurringEventId: 'w' }));
    fake.put(ME, timed('w_2', '2026-10-28T09:00:00+01:00', '2026-10-28T10:00:00+01:00', { recurringEventId: 'w' }));
    await svc.syncAll();
    const list = await events('2026-10-01', '2026-11-30');
    const trip = list.find((e) => e.title === 'Trip');
    expect(trip).toMatchObject({ allDay: true, startDate: '2026-11-12', endDate: '2026-11-13', startAt: null });
    expect(list.filter((e) => e.google.recurringEventId === 'w').map((e) => e.startAt).sort()).toEqual([
      '2026-10-21T07:00:00.000Z', // 09:00 CEST
      '2026-10-28T08:00:00.000Z', // 09:00 CET
    ]);
    expect((await events('2026-11-13', '2026-11-13')).map((e) => e.title)).toEqual(['Trip']);
    expect(await events('2026-11-14', '2026-11-14')).toHaveLength(0);
  });
});

describe('writes (acceptance 4, 6)', () => {
  const create = (clientId = uid(), extra: object = {}) =>
    c.req('POST', '/api/google/events', {
      calendarId: MEC, clientId, title: 'Dentist', allDay: false, startAt: '2026-11-12T09:00:00.000Z', endAt: '2026-11-12T10:00:00.000Z', ...extra,
    });

  it('creates the event in the chosen Google calendar without notifying anyone', async () => {
    const r = await create();
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ source: 'google', title: 'Dentist', google: { calendarId: MEC, readOnly: false } });
    const inGoogle = fake.list(ME);
    expect(inGoogle).toHaveLength(1);
    expect(inGoogle[0]).toMatchObject({ summary: 'Dentist', start: { dateTime: '2026-11-12T09:00:00.000Z', timeZone: 'Europe/Oslo' } });
    const post = fake.calls('POST')[0];
    expect(post.query.get('sendUpdates')).toBe('none');
    expect(post.body.attendees).toBeUndefined();
    expect(await events()).toHaveLength(1);
  });

  it('all-day events are sent with an exclusive end date', async () => {
    await c.req('POST', '/api/google/events', { calendarId: MEC, clientId: uid(), title: 'Holiday', allDay: true, startDate: '2026-11-12', endDate: '2026-11-13' });
    expect(fake.list(ME)[0]).toMatchObject({ start: { date: '2026-11-12' }, end: { date: '2026-11-14' } });
    expect((await events())[0]).toMatchObject({ allDay: true, startDate: '2026-11-12', endDate: '2026-11-13' });
  });

  it('retries transient failures a bounded number of times', async () => {
    fake.failNext = 2;
    expect((await create()).status).toBe(201);
    expect(fake.calls('POST')).toHaveLength(3);

    fake.log = [];
    fake.failNext = 99;
    const r = await create();
    expect(r.status).toBe(502);
    expect(r.json.error).toMatch(/Nothing was changed/);
    expect(fake.calls('POST')).toHaveLength(4); // bounded
    fake.failNext = 0;
    expect(fake.list(ME)).toHaveLength(1);
    expect(await events()).toHaveLength(1); // the failed create is not shown as saved
  });

  it('a create whose response was lost does not produce a duplicate when retried', async () => {
    fake.loseResponseNext = 1; // Google stored it, but we saw an error
    const id = uid();
    const r = await create(id);
    expect(r.status).toBe(201); // the automatic retry found the existing event (409 -> GET)
    expect(fake.list(ME)).toHaveLength(1);
    expect((await create(id)).status).toBe(201); // the user repeating the same request is also harmless
    expect(fake.list(ME)).toHaveLength(1);
    expect(await events()).toHaveLength(1);
  });

  it('refuses to create in a read-only calendar and validates the client id', async () => {
    expect((await create(uid(), { calendarId: cid(HOLIDAYS) })).status).toBe(403);
    expect((await create('NOT-VALID-ID')).status).toBe(400);
    expect(fake.calls('POST')).toHaveLength(0);
  });

  it('detects an external edit instead of overwriting it (ETag conflict)', async () => {
    const ev = (await create()).json;
    const path = gpath(MEC, ev.google.eventId);
    fake.put(ME, { ...fake.get(ME, ev.google.eventId), summary: 'Changed in Google', location: 'Clinic' });

    const r = await c.req('PATCH', path, { etag: ev.google.etag, title: 'My stale edit' });
    expect(r.status).toBe(412);
    expect(fake.get(ME, ev.google.eventId).summary).toBe('Changed in Google'); // not overwritten
    const [fresh] = await events();
    expect(fresh).toMatchObject({ title: 'Changed in Google', location: 'Clinic' }); // latest version now shown

    const ok = await c.req('PATCH', path, { etag: fresh.google.etag, title: 'Edited after review', startAt: '2026-11-12T11:00:00.000Z', endAt: '2026-11-12T12:00:00.000Z' });
    expect(ok.status).toBe(200);
    expect(fake.get(ME, ev.google.eventId)).toMatchObject({ summary: 'Edited after review', location: 'Clinic', start: { dateTime: '2026-11-12T11:00:00.000Z' } });
    expect(fake.calls('PATCH').every((l) => l.query.get('sendUpdates') === 'none')).toBe(true);
  });

  it('deleting is idempotent and conflict-checked', async () => {
    const ev = (await create()).json;
    const path = gpath(MEC, ev.google.eventId);
    fake.put(ME, { ...fake.get(ME, ev.google.eventId), summary: 'Changed' });
    expect((await c.req('DELETE', `${path}?etag=${encodeURIComponent(ev.google.etag)}`)).status).toBe(412);
    expect(fake.list(ME)).toHaveLength(1);
    const [fresh] = await events();
    fake.loseResponseNext = 1; // deleted at Google, response lost, retry sees 410
    expect((await c.req('DELETE', `${path}?etag=${encodeURIComponent(fresh.google.etag)}`)).status).toBe(200);
    expect(fake.list(ME)).toHaveLength(0);
    expect(await events()).toHaveLength(0);
  });

  it('recurring events: change or delete one occurrence, or the whole series', async () => {
    fake.put(ME, { ...timed('s', '2026-11-10T09:00:00+01:00', '2026-11-10T10:00:00+01:00'), recurrence: ['RRULE:FREQ=WEEKLY'], summary: 'Standup' });
    fake.put(ME, timed('s_1', '2026-11-10T09:00:00+01:00', '2026-11-10T10:00:00+01:00', { recurringEventId: 's', summary: 'Standup' }));
    fake.put(ME, timed('s_2', '2026-11-17T09:00:00+01:00', '2026-11-17T10:00:00+01:00', { recurringEventId: 's', summary: 'Standup' }));
    await svc.syncAll();

    await c.req('PATCH', gpath(MEC, 's_2'), { scope: 'occurrence', startAt: '2026-11-17T12:00:00.000Z', endAt: '2026-11-17T13:00:00.000Z' });
    expect(fake.get(ME, 's_2').start.dateTime).toBe('2026-11-17T12:00:00.000Z');
    expect(fake.get(ME, 's').start.dateTime).toBe('2026-11-10T09:00:00+01:00');

    // Whole series: the master is shifted by the same amount (+30 min) with the new length (45 min).
    await c.req('PATCH', gpath(MEC, 's_1'), { scope: 'series', title: 'Daily sync', startAt: '2026-11-10T08:30:00.000Z', endAt: '2026-11-10T09:15:00.000Z' });
    expect(fake.get(ME, 's')).toMatchObject({ summary: 'Daily sync', start: { dateTime: '2026-11-10T08:30:00.000Z' }, end: { dateTime: '2026-11-10T09:15:00.000Z' } });

    await c.req('DELETE', `${gpath(MEC, 's_2')}?scope=occurrence`);
    expect(fake.get(ME, 's_2')).toBeUndefined();
    expect(fake.get(ME, 's')).toBeDefined();
    await c.req('DELETE', `${gpath(MEC, 's_1')}?scope=series`);
    expect(fake.get(ME, 's')).toBeUndefined();
    expect((await events()).filter((e) => e.google.recurringEventId === 's')).toHaveLength(0);
  });
});

describe('mirroring task time blocks to Google', () => {
  const START = '2026-11-12T08:00:00.000Z';
  const END = '2026-11-12T09:00:00.000Z';
  let BLOCKS: string;
  const mirrored = () => fake.list('blocks@group');
  async function enable() {
    BLOCKS = cid('blocks@group');
    const st = (await c.req('PUT', '/api/google/calendars', { selected: [MEC, BLOCKS], defaultCalendarId: MEC, mirrorCalendarId: BLOCKS })).json;
    expect(st.mirrorCalendarId).toBe(BLOCKS);
  }
  const task = async (title = 'Write report') => (await c.req('POST', '/api/tasks', { title, plannedDate: '2026-11-12', dueDate: '2026-11-13' })).json;

  it('is off by default: scheduling a task writes nothing to Google', async () => {
    const t = await task();
    await c.req('POST', `/api/tasks/${t.id}/schedule`, { startAt: START, endAt: END });
    expect(fake.calls('POST')).toHaveLength(0);
  });

  it('creates exactly one copy per block, shows the block once, and keeps the copy in step', async () => {
    await enable();
    const t = await task();
    const block = (await c.req('POST', `/api/tasks/${t.id}/schedule`, { startAt: START, endAt: END })).json;
    expect(mirrored()).toHaveLength(1);
    expect(mirrored()[0]).toMatchObject({ summary: 'Write report', start: { dateTime: START }, extendedProperties: { private: { dashboardBlockId: block.id } } });
    expect(fake.calls('POST').every((l) => l.query.get('sendUpdates') === 'none')).toBe(true);

    // The calendar shows the block, not the block plus its Google copy - also after a sync.
    await svc.syncAll();
    const list = await events();
    expect(list.filter((e) => e.title === 'Write report')).toHaveLength(1);
    expect(list[0]).toMatchObject({ kind: 'task_block', source: 'app', mirror: { state: 'synced', calendarName: 'Time blocks' } });

    // Repeated syncs and reconciles write nothing more.
    const writes = fake.log.filter((l) => l.method !== 'GET').length;
    await svc.syncAll();
    await svc.reconcileMirror();
    expect(fake.log.filter((l) => l.method !== 'GET').length).toBe(writes);
    expect(mirrored()).toHaveLength(1);

    // Moving the block, renaming the task and completing it update the same copy.
    await c.req('PATCH', `/api/events/${block.id}`, { startAt: '2026-11-12T10:00:00.000Z', endAt: '2026-11-12T11:30:00.000Z' });
    await c.req('PATCH', `/api/tasks/${t.id}`, { title: 'Write final report' });
    expect(mirrored()).toHaveLength(1);
    expect(mirrored()[0]).toMatchObject({ summary: 'Write final report', start: { dateTime: '2026-11-12T10:00:00.000Z' }, end: { dateTime: '2026-11-12T11:30:00.000Z' } });
    await c.req('POST', `/api/tasks/${t.id}/complete`);
    expect(mirrored()[0].summary).toBe('✓ Write final report');
    expect((await c.req('GET', `/api/tasks/${t.id}`)).json.dueDate).toBe('2026-11-13'); // deadline untouched

    // Removing the block removes the copy; the task stays.
    await c.req('DELETE', `/api/events/${block.id}`);
    expect(mirrored()).toHaveLength(0);
    expect((await c.req('GET', `/api/tasks/${t.id}`)).status).toBe(200);
  });

  it('a lost response or a failed attempt never produces a second copy', async () => {
    await enable();
    const t = await task();
    fake.loseResponseNext = 1; // Google created the copy but the answer was lost
    await c.req('POST', `/api/tasks/${t.id}/schedule`, { startAt: START, endAt: END });
    expect(mirrored()).toHaveLength(1);

    const t2 = await task('Second');
    fake.failNext = 99; // Google down: the block is still saved locally and marked as not mirrored
    const r = await c.req('POST', `/api/tasks/${t2.id}/schedule`, { startAt: START, endAt: END });
    expect(r.status).toBe(201);
    let blocks = (await events()).filter((e) => e.kind === 'task_block');
    expect(blocks.find((b) => b.title === 'Second').mirror).toMatchObject({ state: 'failed' });
    expect((await status()).mirrorPending).toBe(1);
    fake.failNext = 0;
    await svc.syncAll(); // retried automatically
    await svc.syncAll();
    expect(mirrored().map((e) => e.summary).sort()).toEqual(['Second', 'Write report']);
    blocks = (await events()).filter((e) => e.kind === 'task_block');
    expect(blocks.every((b) => b.mirror.state === 'synced')).toBe(true);
    expect((await status()).mirrorPending).toBe(0);
  });

  it('deleting the task removes the copies of its blocks; turning mirroring off removes all copies', async () => {
    await enable();
    const a = await task('A');
    const b = await task('B');
    await c.req('POST', `/api/tasks/${a.id}/schedule`, { startAt: START, endAt: END });
    await c.req('POST', `/api/tasks/${b.id}/schedule`, { startAt: START, endAt: END });
    expect(mirrored()).toHaveLength(2);
    await c.req('DELETE', `/api/tasks/${a.id}`); // the block goes with the task (cascade)
    expect(mirrored().map((e) => e.summary)).toEqual(['B']);

    await c.req('PUT', '/api/google/calendars', { selected: [MEC, BLOCKS], defaultCalendarId: MEC, mirrorCalendarId: null });
    expect(mirrored()).toHaveLength(0);
    const blocks = (await events()).filter((e) => e.kind === 'task_block');
    expect(blocks).toHaveLength(1); // the block itself is untouched
    expect(blocks[0].mirror).toBeUndefined();
  });

  it('existing blocks are copied when mirroring is switched on, and move when the target changes', async () => {
    const t = await task();
    await c.req('POST', `/api/tasks/${t.id}/schedule`, { startAt: START, endAt: END });
    await enable();
    expect(mirrored()).toHaveLength(1);
    await c.req('PUT', '/api/google/calendars', { selected: [MEC, BLOCKS], defaultCalendarId: MEC, mirrorCalendarId: MEC });
    expect(mirrored()).toHaveLength(0);
    expect(fake.list(ME).map((e) => e.summary)).toEqual(['Write report']);
    expect((await events()).filter((e) => e.title === 'Write report')).toHaveLength(1);
  });

  it('a read-only calendar cannot be the mirror target', async () => {
    expect((await c.req('PUT', '/api/google/calendars', { selected: [MEC], defaultCalendarId: MEC, mirrorCalendarId: cid(HOLIDAYS) })).status).toBe(400);
  });
});

describe('revoked access and outages (acceptance 12)', () => {
  it('revoked access gives an actionable error, keeps cached events and never touches local tasks', async () => {
    fake.put(ME, timed('a', '2026-11-12T09:00:00+01:00', '2026-11-12T10:00:00+01:00'));
    await svc.syncAll();
    await c.req('POST', '/api/tasks', { title: 'Local task', plannedDate: '2026-11-12' });

    fake.revoked.add('me');
    (svc as any).access.clear(); // access token expired
    const r = (await c.req('POST', '/api/google/sync')).json;
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Reconnect/);
    expect(r.status.accounts[0].status).toBe('revoked');
    const w = await c.req('POST', '/api/google/events', { calendarId: MEC, clientId: uid(), title: 'x', allDay: false, startAt: '2026-11-12T09:00:00.000Z', endAt: '2026-11-12T10:00:00.000Z' });
    expect(w.status).toBe(409);
    expect(w.json.error).toMatch(/Reconnect/);

    expect((await c.req('GET', '/api/tasks')).json.map((t: any) => t.title)).toEqual(['Local task']);
    expect((await events()).map((e) => e.title)).toEqual(['a']);
    expect((await c.req('POST', '/api/events', { title: 'Local event', allDay: false, startAt: '2026-11-12T12:00:00.000Z', endAt: '2026-11-12T13:00:00.000Z' })).status).toBe(201);

    // Reconnecting the same account restores it in place: same calendars, same selection.
    fake.revoked.clear();
    await connectAccount();
    const st = await status();
    expect(st.accounts).toMatchObject([{ label: ME, status: 'connected' }]);
    expect(cid(ME)).toBe(MEC);
    expect(st.defaultCalendarId).toBe(MEC);
  });

  it('an expired access token is refreshed transparently', async () => {
    const acc = (await status()).accounts[0].id;
    (svc as any).access.set(acc, { token: 'bad-token', expiresAt: Date.now() + 3_600_000 }); // rejected by Google with 401
    fake.put(ME, timed('a', '2026-11-12T09:00:00+01:00', '2026-11-12T10:00:00+01:00'));
    await svc.syncAll();
    expect(await events()).toHaveLength(1);
  });
});
