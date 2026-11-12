// Intervals.icu: read-only import of planned workouts, completed activities and wellness.
// Nothing is ever written to Intervals.icu. API reference: https://intervals.icu/api/v1/docs
//  - auth: HTTP Basic, username "API_KEY", password = the personal API key
//  - GET /api/v1/athlete/{id}/events?oldest&newest      (planned workouts and calendar entries)
//  - GET /api/v1/athlete/{id}/activities?oldest&newest  (completed activities)
//  - GET /api/v1/athlete/{id}/wellness?oldest&newest    (daily wellness records)
import { addDays, instantToZoned, startOfWeek, todayIn, zonedToInstant, addMinutes } from '../shared/dates';
import type { CalEvent, TrainingItem, TrainingStatus, TrainingSummary, TrainingTotals, WellnessDay } from '../shared/types';
import type { DB } from './db';
import { getSettings, HttpError } from './repo';

const BASE = 'https://intervals.icu/api/v1';
const PAST_DAYS = 90;
const FUTURE_DAYS = 60;
const PLANNED = ['WORKOUT', 'RACE_A', 'RACE_B', 'RACE_C'];

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export class IntervalsError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export class IntervalsClient {
  constructor(
    private cfg: { athleteId: string; apiKey: string },
    private fetchFn: FetchFn = (u, i) => fetch(u, i),
    private sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  get athleteId(): string {
    return this.cfg.athleteId;
  }

  /** GET with bounded retries on network errors, 429 and 5xx. */
  async get(path: string, query: Record<string, string>): Promise<any[]> {
    const url = `${BASE}/athlete/${encodeURIComponent(this.cfg.athleteId)}/${path}?${new URLSearchParams(query)}`;
    const auth = `Basic ${Buffer.from(`API_KEY:${this.cfg.apiKey}`).toString('base64')}`;
    let last = new IntervalsError(0, 'Could not reach Intervals.icu.');
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (attempt > 1) await this.sleep(500 * 2 ** (attempt - 2));
      let res: Response;
      try {
        res = await this.fetchFn(url, { headers: { authorization: auth, accept: 'application/json' } });
      } catch {
        continue;
      }
      if (res.ok) {
        const data = await res.json().catch(() => null);
        if (!Array.isArray(data)) throw new IntervalsError(res.status, 'Intervals.icu sent an unexpected response.');
        return data;
      }
      if (res.status === 401 || res.status === 403) {
        throw new IntervalsError(res.status, 'Intervals.icu rejected the API key or athlete ID. Check INTERVALS_API_KEY and INTERVALS_ATHLETE_ID in .env.');
      }
      if (res.status === 404) throw new IntervalsError(404, 'Intervals.icu did not find that athlete. Check INTERVALS_ATHLETE_ID in .env.');
      last = new IntervalsError(res.status, `Intervals.icu error ${res.status}.`);
      if (res.status !== 429 && res.status < 500) throw last;
    }
    throw last;
  }
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const int = (v: unknown): number | null => (num(v) == null ? null : Math.round(num(v)!));
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const LOCAL_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::(\d{2}))?/;

export class IntervalsService {
  private running: Promise<void> | null = null;

  constructor(
    private db: DB,
    /** null when INTERVALS_ATHLETE_ID / INTERVALS_API_KEY are not set (or in demo mode). */
    private client: IntervalsClient | null,
    private now: () => Date = () => new Date(),
  ) {}

  status(): TrainingStatus {
    const st = this.db.prepare('SELECT * FROM intervals_state WHERE id = 1').get() as any;
    const count = (t: string) => (this.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as any).n as number;
    return {
      state: st?.demo ? 'demo' : !this.client ? 'not_configured' : st?.last_error ? 'error' : st?.last_synced_at ? 'ok' : 'never_synced',
      athleteId: this.client?.athleteId ?? st?.athlete_id ?? null,
      lastSyncedAt: st?.last_synced_at ?? null,
      lastError: st?.last_error ?? null,
      syncing: !!this.running,
      counts: { planned: count('intervals_events'), activities: count('intervals_activities'), wellnessDays: count('intervals_wellness') },
    };
  }

  /** Imports the window [today-90d, today+60d]. Repeat runs update rows in place by source id. */
  sync(): Promise<void> {
    if (this.running) return this.running;
    const run: Promise<void> = this.doSync().finally(() => {
      if (this.running === run) this.running = null;
    });
    this.running = run;
    return run;
  }

  private async doSync(): Promise<void> {
    if (!this.client) return;
    const tz = getSettings(this.db).timezone;
    const today = todayIn(tz, this.now());
    const oldest = addDays(today, -PAST_DAYS);
    const newest = addDays(today, FUTURE_DAYS);
    const ts = this.now().toISOString();
    try {
      // Fetch everything first; write in one transaction so a failure leaves the old data intact.
      const [events, activities, wellness] = [
        await this.client.get('events', { oldest, newest }),
        await this.client.get('activities', { oldest, newest: today }),
        await this.client.get('wellness', { oldest, newest: today }),
      ];
      this.db.transaction(() => {
        const seenE = new Set<string>();
        for (const e of events) {
          const m = LOCAL_RE.exec(String(e.start_date_local ?? ''));
          if (e.id == null || !m || !e.category) continue;
          seenE.add(String(e.id));
          this.db.prepare(
            `INSERT INTO intervals_events (id, category, start_local, end_local, date, has_time, type, name, description, moving_time_s,
               distance_m, load, indoor, updated, fetched_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
             ON CONFLICT(id) DO UPDATE SET category=excluded.category, start_local=excluded.start_local, end_local=excluded.end_local,
               date=excluded.date, has_time=excluded.has_time, type=excluded.type, name=excluded.name, description=excluded.description,
               moving_time_s=excluded.moving_time_s, distance_m=excluded.distance_m, load=excluded.load, indoor=excluded.indoor,
               updated=excluded.updated, fetched_at=excluded.fetched_at`,
          ).run(
            String(e.id), String(e.category), e.start_date_local, str(e.end_date_local), m[1], m[2] === '00:00' ? 0 : 1, str(e.type),
            str(e.name) ?? '', str(e.description) ?? '', int(e.moving_time), num(e.distance), int(e.icu_training_load),
            typeof e.indoor === 'boolean' ? (e.indoor ? 1 : 0) : null, str(e.updated), ts,
          );
        }
        const seenA = new Set<string>();
        for (const a of activities) {
          if (a.id == null) continue;
          seenA.add(String(a.id));
          const m = LOCAL_RE.exec(String(a.start_date_local ?? ''));
          // Some sources (notably Strava) only expose an id and a date through the API.
          const details = a.type != null || a.moving_time != null || a.distance != null;
          this.db.prepare(
            `INSERT INTO intervals_activities (id, start_local, start_utc, date, type, name, moving_time_s, elapsed_time_s, distance_m,
               elevation_m, load, avg_hr, avg_watts, calories, source, paired_event_id, details_available, fetched_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
             ON CONFLICT(id) DO UPDATE SET start_local=excluded.start_local, start_utc=excluded.start_utc, date=excluded.date, type=excluded.type,
               name=excluded.name, moving_time_s=excluded.moving_time_s, elapsed_time_s=excluded.elapsed_time_s, distance_m=excluded.distance_m,
               elevation_m=excluded.elevation_m, load=excluded.load, avg_hr=excluded.avg_hr, avg_watts=excluded.avg_watts, calories=excluded.calories,
               source=excluded.source, paired_event_id=excluded.paired_event_id, details_available=excluded.details_available, fetched_at=excluded.fetched_at`,
          ).run(
            String(a.id), str(a.start_date_local), toInstant(a.start_date), m?.[1] ?? null, str(a.type), str(a.name) ?? '', int(a.moving_time),
            int(a.elapsed_time), num(a.distance), num(a.total_elevation_gain), int(a.icu_training_load), int(a.average_heartrate),
            int(a.icu_average_watts), int(a.calories), str(a.source), a.paired_event_id != null ? String(a.paired_event_id) : null, details ? 1 : 0, ts,
          );
        }
        for (const w of wellness) {
          if (typeof w.id !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(w.id)) continue;
          this.db.prepare(
            `INSERT INTO intervals_wellness (date, ctl, atl, ramp_rate, resting_hr, hrv, hrv_sdnn, sleep_secs, sleep_score, sleep_quality, weight,
               readiness, soreness, fatigue, stress, mood, updated, fetched_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
             ON CONFLICT(date) DO UPDATE SET ctl=excluded.ctl, atl=excluded.atl, ramp_rate=excluded.ramp_rate, resting_hr=excluded.resting_hr,
               hrv=excluded.hrv, hrv_sdnn=excluded.hrv_sdnn, sleep_secs=excluded.sleep_secs, sleep_score=excluded.sleep_score,
               sleep_quality=excluded.sleep_quality, weight=excluded.weight, readiness=excluded.readiness, soreness=excluded.soreness,
               fatigue=excluded.fatigue, stress=excluded.stress, mood=excluded.mood, updated=excluded.updated, fetched_at=excluded.fetched_at`,
          ).run(
            w.id, num(w.ctl), num(w.atl), num(w.rampRate), int(w.restingHR), num(w.hrv), num(w.hrvSDNN), int(w.sleepSecs), num(w.sleepScore),
            int(w.sleepQuality), num(w.weight), num(w.readiness), int(w.soreness), int(w.fatigue), int(w.stress), int(w.mood), str(w.updated), ts,
          );
        }
        // Inside the imported window, rows that Intervals.icu no longer returns were deleted there.
        for (const r of this.db.prepare('SELECT id FROM intervals_events WHERE date BETWEEN ? AND ?').all(oldest, newest) as { id: string }[]) {
          if (!seenE.has(r.id)) this.db.prepare('DELETE FROM intervals_events WHERE id = ?').run(r.id);
        }
        for (const r of this.db.prepare('SELECT id FROM intervals_activities WHERE date BETWEEN ? AND ?').all(oldest, today) as { id: string }[]) {
          if (!seenA.has(r.id)) this.db.prepare('DELETE FROM intervals_activities WHERE id = ?').run(r.id);
        }
        this.setState(ts, null);
      })();
    } catch (e) {
      const msg = e instanceof IntervalsError ? e.message : 'Unexpected error while importing from Intervals.icu.';
      this.setState(null, msg);
      throw new HttpError(502, `${msg} Previously imported training data is still shown.`);
    }
  }

  private setState(syncedAt: string | null, error: string | null): void {
    this.db.prepare(
      `INSERT INTO intervals_state (id, athlete_id, last_synced_at, last_error) VALUES (1, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET athlete_id = excluded.athlete_id, last_synced_at = COALESCE(excluded.last_synced_at, last_synced_at),
         last_error = excluded.last_error`,
    ).run(this.client?.athleteId ?? null, syncedAt, error);
  }

  // ---------- Reading ----------

  private planned(from: string, to: string): TrainingItem[] {
    const paired = new Set(
      (this.db.prepare('SELECT paired_event_id FROM intervals_activities WHERE paired_event_id IS NOT NULL').all() as any[]).map((r) => r.paired_event_id),
    );
    return (
      this.db
        .prepare(`SELECT * FROM intervals_events WHERE date BETWEEN ? AND ? AND category IN (${PLANNED.map(() => '?').join(',')}) ORDER BY start_local`)
        .all(from, to, ...PLANNED) as any[]
    ).map((r) => ({
      id: r.id, what: 'planned', date: r.date, time: r.has_time ? LOCAL_RE.exec(r.start_local)![2] : null, startAt: null,
      name: r.name || r.type || 'Workout', sport: r.type, category: r.category,
      durationMin: r.moving_time_s == null ? null : Math.round(r.moving_time_s / 60),
      distanceKm: r.distance_m == null ? null : Math.round(r.distance_m / 10) / 100,
      load: r.load, avgHr: null, done: paired.has(r.id), pairedEventId: null, detailsAvailable: true, source: 'Intervals.icu',
    }));
  }

  private completed(from: string, to: string): TrainingItem[] {
    return (this.db.prepare('SELECT * FROM intervals_activities WHERE date BETWEEN ? AND ? ORDER BY COALESCE(start_utc, start_local)').all(from, to) as any[]).map(
      (r) => ({
        id: r.id, what: 'completed', date: r.date, time: r.start_local ? (LOCAL_RE.exec(r.start_local)?.[2] ?? null) : null, startAt: r.start_utc,
        name: r.name || r.type || 'Activity', sport: r.type, category: null,
        durationMin: r.moving_time_s == null ? null : Math.round(r.moving_time_s / 60),
        distanceKm: r.distance_m == null ? null : Math.round(r.distance_m / 10) / 100,
        load: r.load, avgHr: r.avg_hr, done: true, pairedEventId: r.paired_event_id, detailsAvailable: !!r.details_available, source: r.source,
      }),
    );
  }

  /**
   * Training as calendar items (read-only). Items with a real start time go on the timed
   * schedule; planned workouts without one are untimed (allDay) and shown in the Training
   * row. A planned workout that has a paired completed activity is not listed a second time.
   */
  listEvents(from: string, to: string): CalEvent[] {
    const tz = getSettings(this.db).timezone;
    const out: CalEvent[] = [];
    const base = { kind: 'training' as const, taskId: null, notes: '', location: '', source: 'intervals' as const, updatedAt: '' };
    const info = (t: TrainingItem) => ({ sourceId: t.id, what: t.what, sport: t.sport, durationMin: t.durationMin, distanceKm: t.distanceKm, load: t.load, done: t.done });
    for (const t of this.planned(from, to)) {
      if (t.done) continue;
      if (t.time) {
        const startAt = zonedToInstant(t.date, t.time, tz);
        out.push({ ...base, id: `ip:${t.id}`, title: t.name, allDay: false, startDate: null, endDate: null, startAt, endAt: addMinutes(startAt, t.durationMin ?? 30), training: info(t) });
      } else {
        out.push({ ...base, id: `ip:${t.id}`, title: t.name, allDay: true, startDate: t.date, endDate: t.date, startAt: null, endAt: null, training: info(t) });
      }
    }
    for (const t of this.completed(addDays(from, -1), addDays(to, 1))) {
      const startAt = t.startAt ?? (t.time ? zonedToInstant(t.date, t.time, tz) : null);
      if (startAt && t.durationMin != null) {
        const day = instantToZoned(startAt, tz).date;
        if (day < from || day > to) continue;
        out.push({ ...base, id: `ia:${t.id}`, title: t.name, allDay: false, startDate: null, endDate: null, startAt, endAt: addMinutes(startAt, Math.max(1, t.durationMin)), training: info(t) });
      } else if (t.date >= from && t.date <= to) {
        out.push({ ...base, id: `ia:${t.id}`, title: t.name, allDay: true, startDate: t.date, endDate: t.date, startAt: null, endAt: null, training: info(t) });
      }
    }
    return out;
  }

  /** Sums only what the source provided. `missing` counts items that had no value. */
  private totals(items: TrainingItem[]): TrainingTotals {
    const sum = (pick: (t: TrainingItem) => number | null) => {
      const known = items.map(pick).filter((v): v is number => v != null);
      return { value: known.length ? Math.round(known.reduce((a, b) => a + b, 0) * 100) / 100 : null, missing: items.length - known.length };
    };
    return { count: items.length, durationMin: sum((t) => t.durationMin), distanceKm: sum((t) => t.distanceKm), load: sum((t) => t.load) };
  }

  summary(weekOf?: string): TrainingSummary {
    const s = getSettings(this.db);
    const today = todayIn(s.timezone, this.now());
    const weekStart = startOfWeek(weekOf ?? today, s.weekStart);
    const weekEnd = addDays(weekStart, 6);
    const planned = this.planned(weekStart, weekEnd);
    const completed = this.completed(weekStart, weekEnd);
    const wellness = (this.db.prepare('SELECT * FROM intervals_wellness WHERE date BETWEEN ? AND ? ORDER BY date').all(addDays(today, -27), today) as any[]).map(
      (w): WellnessDay => ({
        date: w.date, ctl: w.ctl, atl: w.atl, form: w.ctl != null && w.atl != null ? Math.round((w.ctl - w.atl) * 10) / 10 : null,
        rampRate: w.ramp_rate, restingHr: w.resting_hr, hrv: w.hrv, sleepHours: w.sleep_secs == null ? null : Math.round(w.sleep_secs / 360) / 10,
        sleepScore: w.sleep_score, weight: w.weight, readiness: w.readiness,
      }),
    );
    return {
      status: this.status(),
      today,
      todayPlanned: this.planned(today, today),
      todayCompleted: this.completed(today, today),
      upcoming: this.planned(addDays(today, 1), addDays(today, 7)),
      recent: this.completed(addDays(today, -14), today).reverse().slice(0, 10),
      week: {
        start: weekStart, end: weekEnd, planned, completed,
        plannedTotals: this.totals(planned), completedTotals: this.totals(completed),
        // Planned workouts in this week with a paired completed activity. Never added to the totals.
        plannedDone: planned.filter((p) => p.done).length,
      },
      wellness,
    };
  }
}

function toInstant(v: unknown): string | null {
  if (typeof v !== 'string' || !v) return null;
  const t = Date.parse(/[zZ]|[+-]\d{2}:?\d{2}$/.test(v) ? v : `${v}Z`);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}
