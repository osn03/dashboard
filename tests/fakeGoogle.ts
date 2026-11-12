// In-memory stand-in for Google's OAuth and Calendar endpoints. MOCK - used only by tests.
// It imitates the documented behaviour the app relies on: paging, sync tokens, 410 on
// expired tokens, 409 on duplicate ids, ETag preconditions (412), and cancelled items.
// Two Google users exist: "me" (auth code "abc") and "other" (auth code "second").
// Both can see the shared calendar holidays@group; events are stored per calendar.
import type { FetchFn } from '../server/google/client';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const gerr = (status: number, reason = 'error') => json(status, { error: { code: status, message: reason, errors: [{ reason }] } });

export class FakeGoogle {
  users: Record<string, any[]> = {
    me: [
      { id: 'me@example.com', summary: 'Me', accessRole: 'owner', primary: true, timeZone: 'Europe/Oslo', backgroundColor: '#1a73e8' },
      { id: 'holidays@group', summary: 'Holidays', accessRole: 'reader' },
      { id: 'blocks@group', summary: 'Time blocks', accessRole: 'owner', backgroundColor: '#0b8043' },
    ],
    other: [
      { id: 'other@example.com', summary: 'Work', accessRole: 'owner', primary: true, backgroundColor: '#d50000' },
      { id: 'holidays@group', summary: 'Holidays', accessRole: 'reader' },
    ],
  };
  private events = new Map<string, Map<string, any>>();
  private changes = new Map<string, { seq: number; id: string }[]>();
  private seq = 0;
  expiredTokens = new Set<string>();
  /** Users whose refresh token Google no longer accepts. */
  revoked = new Set<string>();
  pageSize = 100;
  /** Next N Calendar API calls answer 503. */
  failNext = 0;
  /** Next N write calls are applied but answer 503 (response lost on the way back). */
  loseResponseNext = 0;
  log: { method: string; path: string; user: string; query: URLSearchParams; headers: Record<string, string>; body: any }[] = [];
  tokenRequests: URLSearchParams[] = [];

  private cal(id: string) {
    if (!this.events.has(id)) this.events.set(id, new Map());
    return this.events.get(id)!;
  }
  private touch(calId: string, id: string) {
    if (!this.changes.has(calId)) this.changes.set(calId, []);
    this.changes.get(calId)!.push({ seq: ++this.seq, id });
  }
  /** Simulates an edit made directly in Google Calendar. */
  put(calId: string, item: any) {
    const prev = this.cal(calId).get(item.id);
    const stored = { status: 'confirmed', ...prev, ...item, etag: `"v${++this.seq}"`, updated: new Date().toISOString() };
    this.cal(calId).set(item.id, stored);
    this.touch(calId, item.id);
    return stored;
  }
  remove(calId: string, id: string) {
    const prev = this.cal(calId).get(id);
    if (prev) this.put(calId, { ...prev, status: 'cancelled' });
  }
  get(calId: string, id: string) {
    const e = this.cal(calId).get(id);
    return e && e.status !== 'cancelled' ? e : undefined;
  }
  list(calId: string) {
    return [...this.cal(calId).values()].filter((e) => e.status !== 'cancelled');
  }
  calls(method: string, pathPart = '') {
    return this.log.filter((l) => l.method === method && l.path.includes(pathPart));
  }

  fetch: FetchFn = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method ?? 'GET';
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));

    if (u.hostname === 'oauth2.googleapis.com') {
      const form = new URLSearchParams(String(init.body));
      if (u.pathname === '/revoke') return json(200, {});
      this.tokenRequests.push(form);
      if (form.get('grant_type') === 'authorization_code') {
        const user = form.get('code') === 'second' ? 'other' : 'me';
        return json(200, {
          access_token: `at-${user}-initial`, refresh_token: `rt-secret-${user}`, expires_in: 3600,
          scope: 'https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/calendar.events',
        });
      }
      const user = String(form.get('refresh_token')).replace('rt-secret-', '');
      return this.revoked.has(user) ? json(400, { error: 'invalid_grant' }) : json(200, { access_token: `at-${user}-${++this.seq}`, expires_in: 3600 });
    }

    const path = decodeURIComponent(u.pathname.replace('/calendar/v3', ''));
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    const tokenMatch = /^Bearer at-([a-z]+)-/.exec(headers.authorization ?? '');
    this.log.push({ method, path, user: tokenMatch?.[1] ?? '', query: u.searchParams, headers, body });
    if (!tokenMatch) return gerr(401, 'authError');
    const user = tokenMatch[1];
    if (this.failNext > 0) {
      this.failNext--;
      return gerr(503, 'backendError');
    }
    const lose = method !== 'GET' && this.loseResponseNext > 0;
    if (lose) this.loseResponseNext--;
    const done = (res: Response) => (lose ? gerr(503, 'backendError') : res);

    if (path === '/users/me/calendarList') return json(200, { items: this.users[user] });

    const m = path.match(/^\/calendars\/([^/]+)\/events(?:\/(.+))?$/);
    if (!m) return gerr(404, 'notFound');
    const [, calId, eventId] = m;
    const entry = this.users[user].find((c) => c.id === calId);
    if (!entry) return gerr(404, 'notFound'); // this user cannot see that calendar
    if (method !== 'GET' && !['owner', 'writer'].includes(entry.accessRole)) return gerr(403, 'forbidden');
    const store = this.cal(calId);

    if (method === 'GET' && !eventId) {
      const syncToken = u.searchParams.get('syncToken');
      if (syncToken && u.searchParams.get('timeMin')) return gerr(400, 'badRequest');
      let items: any[];
      if (syncToken) {
        if (this.expiredTokens.has(syncToken)) return gerr(410, 'fullSyncRequired');
        const since = Number(syncToken.split('-')[1]);
        const ids = [...new Set((this.changes.get(calId) ?? []).filter((c) => c.seq > since).map((c) => c.id))];
        items = ids.map((id) => store.get(id)).map((e) => (e.status === 'cancelled' ? { id: e.id, status: 'cancelled' } : e));
      } else {
        const min = u.searchParams.get('timeMin');
        items = [...store.values()].filter((e) => e.status !== 'cancelled' && (!min || (e.end.dateTime ?? `${e.end.date}T00:00:00Z`) > min));
      }
      // The snapshot position travels in the page token so paging is stable.
      const [offset, snap] = (u.searchParams.get('pageToken') ?? `0:${this.seq}`).split(':').map(Number);
      const page = items.slice(offset, offset + this.pageSize);
      const more = offset + this.pageSize < items.length;
      return json(200, { items: page, ...(more ? { nextPageToken: `${offset + this.pageSize}:${snap}` } : { nextSyncToken: `tok-${snap}` }) });
    }
    if (method === 'GET') {
      const e = this.get(calId, eventId);
      return e ? json(200, e) : gerr(404, 'notFound');
    }
    if (method === 'POST') {
      if (body.id && store.has(body.id)) return gerr(409, 'duplicate');
      const id = body.id ?? `gen${++this.seq}`;
      return done(json(200, this.put(calId, { ...body, id, organizer: { email: calId, self: true }, htmlLink: `https://calendar.example/${id}` })));
    }
    const existing = this.get(calId, eventId);
    if (!existing) return gerr(method === 'DELETE' ? 410 : 404, 'deleted');
    if (headers['if-match'] && headers['if-match'] !== existing.etag) return gerr(412, 'conditionNotMet');
    if (method === 'PATCH') return done(json(200, this.put(calId, { ...existing, ...body })));
    if (method === 'DELETE') {
      this.remove(calId, eventId);
      return done(new Response(null, { status: 204 }));
    }
    return gerr(405, 'methodNotAllowed');
  };
}
