// Google Calendar: accounts, token handling, per-calendar sync, writes and block mirroring.
// Google is the source of truth for Google events; google_events is a local cache.
// Task time blocks are owned by this app; their optional Google copies are derived.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { addDays, dayBounds, diffDays } from '../../shared/dates';
import type {
  CalEvent, GoogleAccountInfo, GoogleCalendarInfo, GoogleEventCreate, GoogleEventPatch, GoogleStatus,
} from '../../shared/types';
import type { Cipher } from '../crypto';
import type { DB } from '../db';
import { getSettings, HttpError } from '../repo';
import { GOOGLE_SCOPES, GoogleApiError, GoogleRevokedError, type ApiOptions, type GoogleClient } from './client';

const FULL_SYNC_PAST_DAYS = 90;
const MAX_PAGES = 80;
const MIRROR_BATCH = 50;
const WRITE = { sendUpdates: 'none' }; // never notify guests implicitly
const PALETTE = ['#1a73e8', '#0b8043', '#d50000', '#8e24aa', '#f4511e', '#039be5', '#616161', '#e67c73', '#33b679', '#f6bf26'];
const enc = encodeURIComponent;

interface AccountRow { id: string; label: string | null; refresh_token_enc: string; status: string; last_error: string | null }
interface CalRow {
  id: string; account_id: string; google_id: string; summary: string; color: string | null; color_override: string | null;
  access_role: string; is_primary: number; selected: number; is_default: number; is_mirror: number;
  sync_token: string | null; last_synced_at: string | null; last_error: string | null;
}

export class GoogleService {
  private access = new Map<string, { token: string; expiresAt: number }>();
  private pending = new Map<string, { verifier: string; returnTo: string; createdAt: number }>();
  private running: Promise<void> | null = null;

  constructor(
    private db: DB,
    /** null when GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not set (or in demo mode). */
    private client: GoogleClient | null,
    private cipher: Cipher | null,
    private now: () => Date = () => new Date(),
  ) {}

  // ---------- Status ----------

  private accounts(): AccountRow[] {
    return this.db.prepare('SELECT * FROM google_accounts ORDER BY connected_at').all() as AccountRow[];
  }
  private cal(id: string): CalRow {
    const r = this.db.prepare('SELECT * FROM google_calendars WHERE id = ?').get(id) as CalRow | undefined;
    if (!r) throw new HttpError(404, 'Unknown calendar');
    return r;
  }
  /** Colour per calendar: the user's override, else Google's, else an unused palette colour. */
  private colors(): Map<string, string> {
    const rows = this.db.prepare('SELECT id, color, color_override FROM google_calendars ORDER BY account_id, is_primary DESC, summary').all() as CalRow[];
    const out = new Map<string, string>();
    const used = new Set<string>();
    for (const r of rows) {
      const c = r.color_override ?? r.color;
      if (c) {
        out.set(r.id, c);
        used.add(c.toLowerCase());
      }
    }
    let i = 0;
    for (const r of rows) {
      if (out.has(r.id)) continue;
      while (i < PALETTE.length - 1 && used.has(PALETTE[i])) i++;
      out.set(r.id, PALETTE[i]);
      used.add(PALETTE[i]);
      i = (i + 1) % PALETTE.length;
    }
    return out;
  }

  status(): GoogleStatus {
    const accounts = this.accounts();
    const label = new Map(accounts.map((a) => [a.id, a.label]));
    const rows = this.db.prepare('SELECT * FROM google_calendars ORDER BY account_id, is_primary DESC, summary').all() as CalRow[];
    const colors = this.colors();
    const calendars = rows.map(
      (r): GoogleCalendarInfo => ({
        id: r.id, accountId: r.account_id, accountLabel: label.get(r.account_id) ?? null, summary: r.summary,
        color: colors.get(r.id)!, colorOverridden: !!r.color_override, accessRole: r.access_role,
        readOnly: !isWritable(r.access_role), primary: !!r.is_primary, selected: !!r.selected,
        isDefault: !!r.is_default, isMirror: !!r.is_mirror, lastSyncedAt: r.last_synced_at, lastError: r.last_error,
      }),
    );
    const canConnect = !!this.client && !!this.cipher;
    return {
      state: accounts.length ? 'connected' : canConnect ? 'disconnected' : 'not_configured',
      canConnect,
      accounts: accounts.map((a): GoogleAccountInfo => ({ id: a.id, label: a.label, status: a.status as GoogleAccountInfo['status'], lastError: a.last_error })),
      calendars,
      defaultCalendarId: calendars.find((c) => c.isDefault)?.id ?? null,
      mirrorCalendarId: calendars.find((c) => c.isMirror)?.id ?? null,
      mirrorPending: this.mirrorBacklog(),
      syncing: !!this.running,
      hidden: (this.db.prepare('SELECT calendar_id, event_key, title FROM google_hidden ORDER BY hidden_at DESC').all() as any[]).map((h) => ({
        calendarId: h.calendar_id, eventKey: h.event_key, title: h.title,
      })),
    };
  }

  private need(): { client: GoogleClient; cipher: Cipher } {
    if (!this.client || !this.cipher) throw new HttpError(409, 'Google Calendar is not set up. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to .env (see README).');
    return { client: this.client, cipher: this.cipher };
  }

  // ---------- OAuth ----------

  /** Starts the authorization-code flow. Each call can add another Google account. */
  startConnect(returnTo: string): string {
    const { client } = this.need();
    for (const [k, v] of this.pending) if (Date.now() - v.createdAt > 10 * 60_000) this.pending.delete(k);
    const state = randomBytes(24).toString('base64url');
    const verifier = randomBytes(48).toString('base64url');
    this.pending.set(state, { verifier, returnTo, createdAt: Date.now() });
    return client.authUrl(state, createHash('sha256').update(verifier).digest('base64url'));
  }

  /**
   * Completes the flow. The account is identified by its primary calendar id: signing in
   * again with a known account refreshes its token (reconnect); a new one is added alongside.
   */
  async finishConnect(code: string, state: string): Promise<string> {
    const { client, cipher } = this.need();
    const p = this.pending.get(state);
    this.pending.delete(state);
    if (!p || Date.now() - p.createdAt > 10 * 60_000) throw new HttpError(400, 'The Google sign-in attempt expired or is unknown. Start again from Settings.');
    const tok = await client.exchangeCode(code, p.verifier).catch((e) => {
      throw new HttpError(502, e instanceof Error ? e.message : 'Google sign-in failed');
    });
    const missing = GOOGLE_SCOPES.filter((s) => !tok.scope.split(' ').includes(s));
    if (missing.length) throw new HttpError(400, 'Google did not grant the calendar permissions. Connect again and leave both calendar permissions ticked.');
    if (!tok.refreshToken) throw new HttpError(400, 'Google did not return a refresh token. Remove this app at myaccount.google.com/permissions, then connect again.');

    let items: any[];
    try {
      items = await this.fetchCalendarList((o) => client.api(tok.accessToken, 'GET', '/users/me/calendarList', o));
    } catch {
      throw new HttpError(502, 'Signed in, but could not read the calendar list from Google. Try connecting again.');
    }
    const label: string | null = items.find((c) => c.primary)?.id ?? null;
    const existing = label ? (this.db.prepare('SELECT id FROM google_accounts WHERE label = ?').get(label) as { id: string } | undefined) : undefined;
    const accountId = existing?.id ?? randomUUID();
    const isNew = !existing;

    this.db.prepare(
      `INSERT INTO google_accounts (id, label, refresh_token_enc, scopes, status, connected_at) VALUES (?, ?, ?, ?, 'connected', ?)
       ON CONFLICT(id) DO UPDATE SET refresh_token_enc = excluded.refresh_token_enc, scopes = excluded.scopes,
         status = 'connected', last_error = NULL`,
    ).run(accountId, label, cipher.encrypt(tok.refreshToken), tok.scope, this.now().toISOString());
    this.access.set(accountId, { token: tok.accessToken, expiresAt: Date.now() + tok.expiresIn * 1000 });
    this.storeCalendarList(accountId, items);

    if (isNew) {
      // A newly added account shows its primary calendar; the default destination is only
      // set if there is none yet, so adding an account never changes where new events go.
      this.db.prepare('UPDATE google_calendars SET selected = 1 WHERE account_id = ? AND is_primary = 1').run(accountId);
      if (!this.db.prepare('SELECT 1 FROM google_calendars WHERE is_default = 1').get()) {
        this.db.prepare('UPDATE google_calendars SET is_default = 1 WHERE account_id = ? AND is_primary = 1').run(accountId);
      }
    }
    await this.syncAll().catch(() => undefined); // errors are recorded per calendar and shown in Settings
    return p.returnTo;
  }

  async disconnect(accountId: string): Promise<{ revokedAtGoogle: boolean }> {
    const acc = this.db.prepare('SELECT * FROM google_accounts WHERE id = ?').get(accountId) as AccountRow | undefined;
    if (!acc) throw new HttpError(404, 'Unknown Google account');
    let revokedAtGoogle = false;
    if (this.client && this.cipher && acc.status !== 'demo') {
      try {
        revokedAtGoogle = await this.client.revoke(this.cipher.decrypt(acc.refresh_token_enc));
      } catch {
        /* token unreadable: still disconnect locally */
      }
    }
    this.db.transaction(() => {
      // Copies of time blocks in this account can no longer be maintained; forget the links.
      this.db.prepare(
        `UPDATE events SET mirror_calendar_id = NULL, mirror_event_id = NULL, mirror_hash = NULL, mirror_error = NULL
         WHERE mirror_calendar_id IN (SELECT id FROM google_calendars WHERE account_id = ?)`,
      ).run(accountId);
      this.db.prepare('DELETE FROM mirror_deletes WHERE calendar_id IN (SELECT id FROM google_calendars WHERE account_id = ?)').run(accountId);
      this.db.prepare('DELETE FROM google_hidden WHERE calendar_id IN (SELECT id FROM google_calendars WHERE account_id = ?)').run(accountId);
      this.db.prepare('DELETE FROM google_accounts WHERE id = ?').run(accountId); // cascades to calendars and cached events
    })();
    this.access.delete(accountId);
    return { revokedAtGoogle };
  }

  private markRevoked(accountId: string): never {
    this.access.delete(accountId);
    this.db.prepare("UPDATE google_accounts SET status = 'revoked', last_error = ? WHERE id = ?").run(
      'Google access was revoked or expired. Reconnect to resume syncing.', accountId,
    );
    throw new HttpError(409, 'Google access was revoked or has expired. Reconnect Google Calendar in Settings. Your tasks and local events are not affected.');
  }

  private async accessToken(accountId: string): Promise<string> {
    const { client, cipher } = this.need();
    const cached = this.access.get(accountId);
    if (cached && cached.expiresAt - Date.now() > 60_000) return cached.token;
    const acc = this.db.prepare('SELECT * FROM google_accounts WHERE id = ?').get(accountId) as AccountRow | undefined;
    if (!acc) throw new HttpError(409, 'Google Calendar is not connected.');
    if (acc.status === 'revoked') throw new HttpError(409, 'Google access was revoked or has expired. Reconnect Google Calendar in Settings.');
    if (acc.status === 'demo') throw new HttpError(409, 'This is a demo calendar; it is not connected to Google.');
    try {
      const t = await client.refresh(cipher.decrypt(acc.refresh_token_enc));
      this.access.set(accountId, { token: t.accessToken, expiresAt: Date.now() + t.expiresIn * 1000 });
      return t.accessToken;
    } catch (e) {
      if (e instanceof GoogleRevokedError) this.markRevoked(accountId);
      throw e;
    }
  }

  /** Authenticated API call for one account; refreshes the access token once on 401. */
  private async call<T = any>(accountId: string, method: string, path: string, opts: ApiOptions = {}): Promise<T> {
    const { client } = this.need();
    try {
      return await client.api<T>(await this.accessToken(accountId), method, path, opts);
    } catch (e) {
      if (e instanceof GoogleApiError && e.status === 401) {
        this.access.delete(accountId);
        return client.api<T>(await this.accessToken(accountId), method, path, opts);
      }
      throw e;
    }
  }

  // ---------- Calendars ----------

  private async fetchCalendarList(get: (opts: ApiOptions) => Promise<any>): Promise<any[]> {
    const items: any[] = [];
    let pageToken: string | undefined;
    let pages = 0;
    do {
      const d = await get({ query: { maxResults: '250', pageToken } });
      items.push(...(d.items ?? []));
      pageToken = d.nextPageToken;
    } while (pageToken && ++pages < MAX_PAGES);
    return items;
  }

  private storeCalendarList(accountId: string, items: any[]): void {
    this.db.transaction(() => {
      const keep = new Set<string>();
      for (const c of items) {
        if (c.deleted || !c.id) continue;
        keep.add(c.id);
        const vals = [c.summaryOverride ?? c.summary ?? c.id, c.backgroundColor ?? null, c.accessRole ?? 'reader', c.primary ? 1 : 0, c.timeZone ?? null];
        const row = this.db.prepare('SELECT id FROM google_calendars WHERE account_id = ? AND google_id = ?').get(accountId, c.id) as { id: string } | undefined;
        if (row) {
          this.db.prepare('UPDATE google_calendars SET summary = ?, color = ?, access_role = ?, is_primary = ?, time_zone = ? WHERE id = ?').run(...vals, row.id);
        } else {
          this.db.prepare(
            'INSERT INTO google_calendars (id, account_id, google_id, summary, color, access_role, is_primary, time_zone) VALUES (?,?,?,?,?,?,?,?)',
          ).run(randomUUID(), accountId, c.id, ...vals);
        }
      }
      for (const r of this.db.prepare('SELECT id, google_id FROM google_calendars WHERE account_id = ?').all(accountId) as { id: string; google_id: string }[]) {
        if (!keep.has(r.google_id)) this.db.prepare('DELETE FROM google_calendars WHERE id = ?').run(r.id);
      }
      // A calendar that lost write access cannot stay the default or the mirror target.
      this.db.prepare("UPDATE google_calendars SET is_default = 0, is_mirror = 0 WHERE access_role NOT IN ('owner','writer')").run();
    })();
  }

  async refreshCalendars(accountId: string): Promise<void> {
    this.storeCalendarList(accountId, await this.fetchCalendarList((o) => this.call(accountId, 'GET', '/users/me/calendarList', o)));
  }

  async setCalendars(
    selected: string[],
    defaultCalendarId: string | null,
    mirrorCalendarId?: string | null,
    colors?: Record<string, string | null>,
  ): Promise<void> {
    const known = new Map((this.db.prepare('SELECT id, access_role FROM google_calendars').all() as any[]).map((r) => [r.id, r.access_role]));
    if ([...selected, ...Object.keys(colors ?? {})].some((id) => !known.has(id))) throw new HttpError(400, 'Unknown calendar');
    for (const [what, id] of [['default', defaultCalendarId], ['mirror', mirrorCalendarId]] as const) {
      if (id && !isWritable(known.get(id))) throw new HttpError(400, `The ${what} calendar must be one you can write to`);
    }
    this.db.transaction(() => {
      this.db.prepare('UPDATE google_calendars SET selected = 0, is_default = 0').run();
      const set = this.db.prepare('UPDATE google_calendars SET selected = 1 WHERE id = ?');
      for (const id of selected) set.run(id);
      // Calendars that are no longer shown drop their cache and token, so re-selecting does a clean full sync.
      this.db.prepare('DELETE FROM google_events WHERE calendar_id IN (SELECT id FROM google_calendars WHERE selected = 0)').run();
      this.db.prepare('UPDATE google_calendars SET sync_token = NULL, last_synced_at = NULL, last_error = NULL WHERE selected = 0').run();
      if (defaultCalendarId) this.db.prepare('UPDATE google_calendars SET is_default = 1 WHERE id = ?').run(defaultCalendarId);
      if (mirrorCalendarId !== undefined) {
        this.db.prepare('UPDATE google_calendars SET is_mirror = 0').run();
        if (mirrorCalendarId) this.db.prepare('UPDATE google_calendars SET is_mirror = 1 WHERE id = ?').run(mirrorCalendarId);
      }
      for (const [id, color] of Object.entries(colors ?? {})) {
        this.db.prepare('UPDATE google_calendars SET color_override = ? WHERE id = ?').run(color, id);
      }
    })();
  }

  // ---------- Sync ----------

  /**
   * Refreshes calendar lists and syncs every selected calendar of every connected account,
   * then brings mirrored time blocks up to date. Concurrent calls share one run.
   */
  syncAll(): Promise<void> {
    if (this.running) return this.running;
    // The guard is cleared from a promise callback, never synchronously: a run that returns
    // before its first await must not leave a finished promise behind as "still running".
    const run: Promise<void> = this.doSync().finally(() => {
      if (this.running === run) this.running = null;
    });
    this.running = run;
    return run;
  }

  private async doSync(): Promise<void> {
    if (!this.client || !this.cipher) return;
    let firstError: unknown;
    for (const acc of this.accounts()) {
      if (acc.status !== 'connected') continue;
      let accountError: unknown;
      try {
        await this.refreshCalendars(acc.id);
      } catch (e) {
        accountError = e;
      }
      if (!accountError) {
        const cals = this.db.prepare('SELECT id FROM google_calendars WHERE account_id = ? AND selected = 1').all(acc.id) as { id: string }[];
        for (const { id } of cals) {
          try {
            await this.syncCalendar(id);
          } catch (e) {
            accountError ??= e;
            this.db.prepare('UPDATE google_calendars SET last_error = ? WHERE id = ?').run(describe(e), id);
          }
        }
      }
      // A revoked account already carries its own message; do not overwrite it.
      this.db.prepare("UPDATE google_accounts SET last_error = ? WHERE id = ? AND status = 'connected'").run(accountError ? describe(accountError) : null, acc.id);
      firstError ??= accountError;
    }
    try {
      await this.reconcileMirror();
    } catch (e) {
      firstError ??= e;
    }
    if (firstError) throw firstError;
  }

  /**
   * Incremental sync with the calendar's own sync token; full sync when there is none or
   * Google answers 410 (token expired). All pages are fetched before anything is written,
   * so a failure half-way never leaves a partial state or advances the token.
   */
  async syncCalendar(calendarId: string): Promise<{ full: boolean; changed: number }> {
    const cal = this.cal(calendarId);
    let token: string | null = cal.sync_token;

    for (let attempt = 0; ; attempt++) {
      try {
        const items: any[] = [];
        let pageToken: string | undefined;
        let next: string | undefined;
        let pages = 0;
        do {
          const query: Record<string, string | undefined> = { singleEvents: 'true', maxResults: '2500', pageToken };
          if (token) query.syncToken = token;
          else query.timeMin = new Date(this.now().getTime() - FULL_SYNC_PAST_DAYS * 864e5).toISOString();
          const d = await this.call(cal.account_id, 'GET', `/calendars/${enc(cal.google_id)}/events`, { query });
          items.push(...(d.items ?? []));
          pageToken = d.nextPageToken;
          next = d.nextSyncToken ?? next;
          if (++pages > MAX_PAGES) throw new GoogleApiError(0, 'Calendar is too large to sync (page limit reached)');
        } while (pageToken);

        const full = !token;
        this.db.transaction(() => {
          if (full) this.db.prepare('DELETE FROM google_events WHERE calendar_id = ?').run(calendarId);
          for (const item of items) this.store(cal, item);
          this.db.prepare('UPDATE google_calendars SET sync_token = ?, last_synced_at = ?, last_error = NULL WHERE id = ?').run(
            next ?? null, this.now().toISOString(), calendarId,
          );
        })();
        return { full, changed: items.length };
      } catch (e) {
        if (e instanceof GoogleApiError && e.status === 410 && token && attempt === 0) {
          token = null; // expired sync token: wipe and start over
          this.db.prepare('UPDATE google_calendars SET sync_token = NULL WHERE id = ?').run(calendarId);
          continue;
        }
        throw e;
      }
    }
  }

  /** Upserts one Google event resource into the cache (or removes it when cancelled). */
  private store(cal: Pick<CalRow, 'id' | 'google_id' | 'access_role'>, item: any): void {
    if (!item?.id) return;
    if (item.status === 'cancelled' || !item.start || !item.end) {
      this.db.prepare('DELETE FROM google_events WHERE calendar_id = ? AND id = ?').run(cal.id, item.id);
      return;
    }
    const allDay = !!item.start.date;
    const type = item.eventType ?? 'default';
    const ownedByCalendar = !item.organizer?.email || item.organizer.email === cal.google_id || item.organizer.self === true;
    const canEdit = isWritable(cal.access_role) && type === 'default' && (ownedByCalendar || item.guestsCanModify === true);
    this.db.prepare(
      `INSERT INTO google_events (calendar_id, id, etag, summary, description, location, html_link, all_day, start_date, end_date,
         start_at, end_at, recurring_event_id, event_type, can_edit, has_guests, updated, fetched_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(calendar_id, id) DO UPDATE SET etag = excluded.etag, summary = excluded.summary, description = excluded.description,
         location = excluded.location, html_link = excluded.html_link, all_day = excluded.all_day, start_date = excluded.start_date,
         end_date = excluded.end_date, start_at = excluded.start_at, end_at = excluded.end_at, recurring_event_id = excluded.recurring_event_id,
         event_type = excluded.event_type, can_edit = excluded.can_edit, has_guests = excluded.has_guests, updated = excluded.updated,
         fetched_at = excluded.fetched_at`,
    ).run(
      cal.id, item.id, item.etag ?? null, item.summary ?? '(No title)', item.description ?? '', item.location ?? '', item.htmlLink ?? null,
      allDay ? 1 : 0,
      allDay ? item.start.date : null,
      allDay ? addDays(item.end.date, -1) : null, // Google's all-day end is exclusive
      allDay ? null : new Date(item.start.dateTime).toISOString(),
      allDay ? null : new Date(item.end.dateTime).toISOString(),
      item.recurringEventId ?? null, type, canEdit ? 1 : 0, item.attendees?.length ? 1 : 0, item.updated ?? null, this.now().toISOString(),
    );
  }

  // ---------- Reading the cache ----------

  private static readonly SELECT = `
    SELECT e.*, c.summary AS cal_summary, c.access_role,
           c.account_id, c.google_id, a.label AS account_label
    FROM google_events e
    JOIN google_calendars c ON c.id = e.calendar_id
    LEFT JOIN google_accounts a ON a.id = c.account_id`;

  private toEvent(r: any, colors: Map<string, string> = this.colors()): CalEvent {
    return {
      id: `g:${r.calendar_id}:${r.id}`,
      kind: 'event', taskId: null, title: r.summary, notes: r.description, location: r.location,
      allDay: !!r.all_day, startDate: r.start_date, endDate: r.end_date, startAt: r.start_at, endAt: r.end_at,
      source: 'google', updatedAt: r.updated ?? r.fetched_at,
      google: {
        calendarId: r.calendar_id, eventId: r.id, calendarName: r.cal_summary, accountLabel: r.account_label ?? null,
        color: colors.get(r.calendar_id) ?? null, readOnly: !r.can_edit, recurringEventId: r.recurring_event_id, htmlLink: r.html_link,
        etag: r.etag, hasGuests: !!r.has_guests, fetchedAt: r.fetched_at,
      },
    };
  }

  private row(calendarId: string, eventId: string): any {
    const r = this.db.prepare(`${GoogleService.SELECT} WHERE e.calendar_id = ? AND e.id = ?`).get(calendarId, eventId);
    if (!r) throw new HttpError(404, 'That event is no longer in the calendar. Refresh to see the current state.');
    return r;
  }

  getEvent(calendarId: string, eventId: string): CalEvent {
    return this.toEvent(this.row(calendarId, eventId));
  }

  /**
   * Cached events of all selected calendars overlapping [from, to] (inclusive dates, user
   * timezone). Left out: events the user hid, and Google copies of this app's own time
   * blocks (the block itself is already shown).
   */
  listEvents(from: string, to: string): CalEvent[] {
    const tz = getSettings(this.db).timezone;
    const colors = this.colors();
    return (
      this.db
        .prepare(
          `${GoogleService.SELECT}
           WHERE c.selected = 1 AND e.event_type != 'workingLocation'
             AND ((e.all_day = 0 AND e.start_at < ? AND e.end_at > ?) OR (e.all_day = 1 AND e.start_date <= ? AND e.end_date >= ?))
             AND NOT EXISTS (SELECT 1 FROM google_hidden h WHERE h.calendar_id = e.calendar_id AND h.event_key = COALESCE(e.recurring_event_id, e.id))
             AND NOT EXISTS (SELECT 1 FROM events b WHERE b.mirror_calendar_id = e.calendar_id AND b.mirror_event_id = e.id)
             AND NOT EXISTS (SELECT 1 FROM mirror_deletes d WHERE d.calendar_id = e.calendar_id AND d.event_id = e.id)`,
        )
        .all(dayBounds(to, tz).end, dayBounds(from, tz).start, to, from) as any[]
    ).map((r) => this.toEvent(r, colors));
  }

  hide(calendarId: string, eventId: string): void {
    const r = this.row(calendarId, eventId);
    this.db.prepare('INSERT OR REPLACE INTO google_hidden (calendar_id, event_key, title, hidden_at) VALUES (?,?,?,?)').run(
      calendarId, r.recurring_event_id ?? r.id, r.summary, this.now().toISOString(),
    );
  }

  unhide(calendarId: string, eventKey: string): void {
    this.db.prepare('DELETE FROM google_hidden WHERE calendar_id = ? AND event_key = ?').run(calendarId, eventKey);
  }

  // ---------- Writes (Google first; the cache only changes after Google confirms) ----------

  private times(e: { allDay: boolean; startDate?: string | null; endDate?: string | null; startAt?: string | null; endAt?: string | null }, tz: string) {
    return e.allDay
      ? { start: { date: e.startDate! }, end: { date: addDays(e.endDate!, 1) } }
      : { start: { dateTime: e.startAt!, timeZone: tz }, end: { dateTime: e.endAt!, timeZone: tz } };
  }

  private fail(e: unknown): never {
    if (e instanceof HttpError) throw e;
    if (e instanceof GoogleApiError) {
      if (e.status === 403 || e.status === 401) throw new HttpError(403, 'Google did not allow this change (the calendar or event is read-only for you). Nothing was changed.');
      if (e.status === 0) throw new HttpError(502, 'Could not reach Google Calendar. Nothing was changed - try again.');
      throw new HttpError(502, `Google Calendar reported an error (${e.status}). Nothing was changed.`);
    }
    throw e;
  }

  /**
   * Creates an event with a client-chosen id in one specific calendar. If a retry hits
   * "already exists" (409), the existing event is fetched and returned, so retries never
   * create duplicates. Event ids are only ever compared within their own calendar.
   */
  async createEvent(input: GoogleEventCreate): Promise<CalEvent> {
    const cal = this.cal(input.calendarId);
    if (!isWritable(cal.access_role)) throw new HttpError(403, `"${cal.summary}" is read-only. Choose a calendar you can write to.`);
    const tz = getSettings(this.db).timezone;
    // Standard reminders (the calendar's own defaults) unless specific times were chosen.
    const custom = Array.isArray(input.reminders) ? [...new Set(input.reminders)] : null;
    const reminders = custom ? { useDefault: false, overrides: custom.map((minutes) => ({ method: 'popup', minutes })) } : { useDefault: true };
    const body = { id: input.clientId, summary: input.title, description: input.notes, location: input.location, reminders, ...this.times(input, tz) };
    const path = `/calendars/${enc(cal.google_id)}/events`;
    let item: any;
    try {
      try {
        item = await this.call(cal.account_id, 'POST', path, { query: WRITE, body });
      } catch (e) {
        if (!(e instanceof GoogleApiError && e.status === 409)) throw e;
        item = await this.call(cal.account_id, 'GET', `${path}/${enc(input.clientId)}`); // created by an earlier attempt
      }
    } catch (e) {
      this.fail(e);
    }
    this.store(cal, item);
    return this.toEvent(this.row(cal.id, item.id));
  }

  /** Re-reads one event from Google after a conflict so the user sees the current version. */
  private async refetch(cal: CalRow, eventId: string): Promise<void> {
    try {
      this.store(cal, await this.call(cal.account_id, 'GET', `/calendars/${enc(cal.google_id)}/events/${enc(eventId)}`));
    } catch (e) {
      if (e instanceof GoogleApiError && (e.status === 404 || e.status === 410)) {
        this.db.prepare('DELETE FROM google_events WHERE calendar_id = ? AND id = ?').run(cal.id, eventId);
      }
    }
  }

  async updateEvent(calendarId: string, eventId: string, patch: GoogleEventPatch): Promise<CalEvent> {
    const row = this.row(calendarId, eventId);
    const cal = this.cal(calendarId);
    if (!row.can_edit) throw new HttpError(403, 'This event is read-only.');
    const tz = getSettings(this.db).timezone;
    const body: Record<string, unknown> = {};
    if (patch.title !== undefined) body.summary = patch.title;
    if (patch.notes !== undefined) body.description = patch.notes;
    if (patch.location !== undefined) body.location = patch.location;

    const timeChange = row.all_day ? patch.startDate !== undefined || patch.endDate !== undefined : patch.startAt !== undefined || patch.endAt !== undefined;
    if (row.all_day && (patch.startAt || patch.endAt)) throw new HttpError(400, 'All-day events use startDate/endDate');
    if (!row.all_day && (patch.startDate || patch.endDate)) throw new HttpError(400, 'Timed events use startAt/endAt');
    const next = {
      allDay: !!row.all_day,
      startDate: patch.startDate ?? row.start_date, endDate: patch.endDate ?? row.end_date,
      startAt: patch.startAt ?? row.start_at, endAt: patch.endAt ?? row.end_at,
    };
    if (next.allDay ? next.endDate < next.startDate : next.endAt <= next.startAt) throw new HttpError(400, 'End must be after start');

    const series = patch.scope === 'series' && row.recurring_event_id;
    const base = `/calendars/${enc(cal.google_id)}/events`;
    try {
      if (series) {
        // Whole series: apply the same shift and new length to the recurring master.
        const master = await this.call(cal.account_id, 'GET', `${base}/${enc(row.recurring_event_id)}`);
        if (timeChange) {
          if (next.allDay) {
            const start = addDays(master.start.date, diffDays(row.start_date, next.startDate));
            body.start = { date: start };
            body.end = { date: addDays(start, diffDays(next.startDate, next.endDate) + 1) };
          } else {
            const start = Date.parse(master.start.dateTime) + (Date.parse(next.startAt) - Date.parse(row.start_at));
            const length = Date.parse(next.endAt) - Date.parse(next.startAt);
            body.start = { dateTime: new Date(start).toISOString(), timeZone: master.start.timeZone ?? tz };
            body.end = { dateTime: new Date(start + length).toISOString(), timeZone: master.end?.timeZone ?? master.start.timeZone ?? tz };
          }
        }
        await this.call(cal.account_id, 'PATCH', `${base}/${enc(row.recurring_event_id)}`, { query: WRITE, body, headers: master.etag ? { 'If-Match': master.etag } : {} });
        await this.syncCalendar(calendarId); // instances are regenerated by Google
        const again = this.db.prepare('SELECT 1 FROM google_events WHERE calendar_id = ? AND id = ?').get(calendarId, eventId);
        return again ? this.toEvent(this.row(calendarId, eventId)) : { ...this.toEvent(row), title: patch.title ?? row.summary };
      }
      if (timeChange) Object.assign(body, this.times(next, tz));
      const etag = patch.etag ?? row.etag;
      const item = await this.call(cal.account_id, 'PATCH', `${base}/${enc(eventId)}`, { query: WRITE, body, headers: etag ? { 'If-Match': etag } : {} });
      this.store(cal, item);
      return this.toEvent(this.row(calendarId, item.id));
    } catch (e) {
      if (e instanceof GoogleApiError && e.status === 412) {
        await this.refetch(cal, eventId);
        throw new HttpError(412, 'This event was changed in Google Calendar after you opened it. Nothing was overwritten - the latest version is now shown. Review it and try again.');
      }
      if (e instanceof GoogleApiError && (e.status === 404 || e.status === 410)) {
        this.db.prepare('DELETE FROM google_events WHERE calendar_id = ? AND id = ?').run(calendarId, eventId);
        throw new HttpError(404, 'This event was deleted in Google Calendar. It has been removed here too.');
      }
      this.fail(e);
    }
  }

  async deleteEvent(calendarId: string, eventId: string, scope: 'occurrence' | 'series', etag: string | null): Promise<void> {
    const row = this.row(calendarId, eventId);
    const cal = this.cal(calendarId);
    if (!row.can_edit) throw new HttpError(403, 'This event is read-only.');
    const series = scope === 'series' && row.recurring_event_id;
    const target = series ? row.recurring_event_id : eventId;
    const ifMatch = series ? null : (etag ?? row.etag);
    try {
      await this.call(cal.account_id, 'DELETE', `/calendars/${enc(cal.google_id)}/events/${enc(target)}`, { query: WRITE, headers: ifMatch ? { 'If-Match': ifMatch } : {} });
    } catch (e) {
      if (e instanceof GoogleApiError && e.status === 412) {
        await this.refetch(cal, eventId);
        throw new HttpError(412, 'This event was changed in Google Calendar after you opened it. It was not deleted - the latest version is now shown.');
      }
      // Already gone at Google (e.g. a retried delete): that is the outcome we wanted.
      if (!(e instanceof GoogleApiError && (e.status === 404 || e.status === 410))) this.fail(e);
    }
    if (series) this.db.prepare('DELETE FROM google_events WHERE calendar_id = ? AND (id = ? OR recurring_event_id = ?)').run(calendarId, target, target);
    else this.db.prepare('DELETE FROM google_events WHERE calendar_id = ? AND id = ?').run(calendarId, eventId);
  }

  // ---------- Mirroring task time blocks ----------

  private mirrorTarget(): CalRow | undefined {
    return this.db
      .prepare(
        `SELECT c.* FROM google_calendars c JOIN google_accounts a ON a.id = c.account_id
         WHERE c.is_mirror = 1 AND a.status = 'connected' AND c.access_role IN ('owner','writer')`,
      )
      .get() as CalRow | undefined;
  }

  private static readonly BLOCKS = `
    SELECT e.id, e.start_at, e.end_at, e.mirror_calendar_id, e.mirror_event_id, e.mirror_hash, t.title, t.status
    FROM events e JOIN tasks t ON t.id = e.task_id WHERE e.kind = 'task_block'`;

  private blockHash(b: any, calendarId: string): string {
    return createHash('sha256').update([calendarId, b.title, b.status, b.start_at, b.end_at].join('|')).digest('hex').slice(0, 32);
  }

  /** How many blocks or leftover copies still need a write at Google. */
  mirrorBacklog(): number {
    const deletes = (this.db.prepare('SELECT COUNT(*) AS n FROM mirror_deletes').get() as any).n as number;
    const target = this.mirrorTarget();
    if (!target) return deletes + (this.db.prepare('SELECT COUNT(*) AS n FROM events WHERE mirror_event_id IS NOT NULL').get() as any).n;
    return deletes + (this.db.prepare(GoogleService.BLOCKS).all() as any[]).filter((b) => b.mirror_hash !== this.blockHash(b, target.id)).length;
  }

  /**
   * Makes Google match the app's time blocks. Safe to run any number of times:
   *  - each block maps to exactly one Google event id derived from the block id, so a
   *    retried create answers 409 and becomes an update - never a second copy;
   *  - a block is only written when its title, state or times differ from what was last pushed;
   *  - copies of deleted blocks (and copies in a calendar that is no longer the target)
   *    are removed.
   * Failures are recorded per block and retried on the next run.
   */
  async reconcileMirror(): Promise<{ written: number; removed: number; failed: number }> {
    const out = { written: 0, removed: 0, failed: 0 };
    if (!this.client || !this.cipher) return out;
    const target = this.mirrorTarget();

    // Copies that live somewhere other than the current target must go.
    this.db.transaction(() => {
      const stale = this.db.prepare('SELECT id, mirror_calendar_id, mirror_event_id FROM events WHERE mirror_event_id IS NOT NULL AND mirror_calendar_id IS NOT ?').all(target?.id ?? null) as any[];
      for (const s of stale) {
        this.db.prepare('INSERT OR IGNORE INTO mirror_deletes (calendar_id, event_id, created_at) VALUES (?,?,?)').run(s.mirror_calendar_id, s.mirror_event_id, this.now().toISOString());
        this.db.prepare('UPDATE events SET mirror_calendar_id = NULL, mirror_event_id = NULL, mirror_hash = NULL, mirror_error = NULL WHERE id = ?').run(s.id);
      }
    })();

    for (const d of this.db.prepare('SELECT * FROM mirror_deletes LIMIT ?').all(MIRROR_BATCH) as any[]) {
      const cal = this.db.prepare('SELECT * FROM google_calendars WHERE id = ?').get(d.calendar_id) as CalRow | undefined;
      try {
        if (cal) {
          try {
            await this.call(cal.account_id, 'DELETE', `/calendars/${enc(cal.google_id)}/events/${enc(d.event_id)}`, { query: WRITE });
          } catch (e) {
            if (!(e instanceof GoogleApiError && (e.status === 404 || e.status === 410))) throw e;
          }
        }
        this.db.prepare('DELETE FROM mirror_deletes WHERE calendar_id = ? AND event_id = ?').run(d.calendar_id, d.event_id);
        this.db.prepare('DELETE FROM google_events WHERE calendar_id = ? AND id = ?').run(d.calendar_id, d.event_id);
        out.removed++;
      } catch {
        out.failed++; // stays queued
      }
    }
    if (!target) return out;

    const tz = getSettings(this.db).timezone;
    const base = `/calendars/${enc(target.google_id)}/events`;
    const todo = (this.db.prepare(GoogleService.BLOCKS).all() as any[]).filter((b) => b.mirror_hash !== this.blockHash(b, target.id)).slice(0, MIRROR_BATCH);
    for (const b of todo) {
      const eventId = `tb${String(b.id).replaceAll('-', '')}`; // base32hex-safe and stable for this block
      const body = {
        summary: `${b.status === 'done' ? '✓ ' : ''}${b.title}`,
        description: 'Time block for a task in your dashboard. Changes made here in Google are overwritten by the dashboard.',
        start: { dateTime: b.start_at, timeZone: tz },
        end: { dateTime: b.end_at, timeZone: tz },
        extendedProperties: { private: { dashboardBlockId: String(b.id) } },
      };
      try {
        let item: any;
        if (b.mirror_event_id) {
          item = await this.call(target.account_id, 'PATCH', `${base}/${enc(eventId)}`, { query: WRITE, body });
        } else {
          try {
            item = await this.call(target.account_id, 'POST', base, { query: WRITE, body: { id: eventId, ...body } });
          } catch (e) {
            if (!(e instanceof GoogleApiError && e.status === 409)) throw e;
            // The copy already exists (earlier attempt whose answer was lost): update it instead.
            item = await this.call(target.account_id, 'PATCH', `${base}/${enc(eventId)}`, { query: WRITE, body: { ...body, status: 'confirmed' } });
          }
        }
        this.db.transaction(() => {
          this.db.prepare('UPDATE events SET mirror_calendar_id = ?, mirror_event_id = ?, mirror_hash = ?, mirror_error = NULL WHERE id = ?').run(
            target.id, eventId, this.blockHash(b, target.id), b.id,
          );
          if (item?.id) this.store(target, item);
        })();
        out.written++;
      } catch (e) {
        const gone = e instanceof GoogleApiError && (e.status === 404 || e.status === 410);
        const msg = gone ? 'The copy was deleted in Google Calendar. It is not recreated automatically.' : describe(e);
        // A copy the user deleted at Google is settled (hash stored); anything else is retried.
        this.db.prepare('UPDATE events SET mirror_error = ?, mirror_hash = CASE WHEN ? THEN ? ELSE mirror_hash END WHERE id = ?').run(
          msg, gone ? 1 : 0, this.blockHash(b, target.id), b.id,
        );
        out.failed++;
      }
    }
    return out;
  }

  /** Runs after changes to tasks or blocks; never throws (state is kept and retried). */
  async mirrorSoon(): Promise<void> {
    if (!this.client || this.mirrorBacklog() === 0) return;
    await this.reconcileMirror().catch(() => undefined);
  }
}

function isWritable(role: string | undefined): boolean {
  return role === 'owner' || role === 'writer';
}

/** Short, safe description of a failure for display. Never includes tokens or payloads. */
function describe(e: unknown): string {
  if (e instanceof HttpError) return e.message;
  if (e instanceof GoogleRevokedError) return 'Google access was revoked or expired. Reconnect to resume syncing.';
  if (e instanceof GoogleApiError) return e.status === 0 ? 'Could not reach Google Calendar.' : `Google Calendar error ${e.status}${e.reason ? ` (${e.reason})` : ''}.`;
  return 'Unexpected sync error.';
}
