// MOCKED: the real import code runs against a fake Intervals.icu HTTP endpoint.
// Field names follow https://intervals.icu/api/v1/docs; no live account was used.
import { beforeEach, describe, expect, it } from 'vitest';
import type { DB } from '../server/db';
import { IntervalsClient, IntervalsService } from '../server/intervals';
import { makeClient, type TestClient } from './helpers';

const NOW = new Date('2026-11-11T10:00:00Z'); // Wednesday; week = Mon 9 .. Sun 15 Nov

class FakeIntervals {
  events: any[] = [];
  activities: any[] = [];
  wellness: any[] = [];
  status = 200;
  failNext = 0;
  log: { path: string; query: URLSearchParams; auth: string }[] = [];
  fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const u = new URL(url);
    this.log.push({ path: u.pathname, query: u.searchParams, auth: String((init?.headers as any)?.authorization) });
    if (init?.method && init.method !== 'GET') throw new Error('the import must never write');
    if (this.failNext > 0) {
      this.failNext--;
      return new Response('{}', { status: 503 });
    }
    if (this.status !== 200) return new Response('{}', { status: this.status });
    const kind = u.pathname.split('/').pop()!;
    return new Response(JSON.stringify((this as any)[kind] ?? []), { status: 200 });
  };
}

let fake: FakeIntervals;
let c: TestClient;
let svc: IntervalsService;

beforeEach(async () => {
  fake = new FakeIntervals();
  fake.events = [
    { id: 101, category: 'WORKOUT', start_date_local: '2026-11-11T00:00:00', type: 'Run', name: 'Easy run', moving_time: 2700, icu_training_load: 35, distance: 8000 },
    { id: 102, category: 'WORKOUT', start_date_local: '2026-11-12T17:30:00', type: 'Ride', name: 'Intervals 4x8', moving_time: 5400, icu_training_load: 90 },
    { id: 103, category: 'WORKOUT', start_date_local: '2026-11-10T00:00:00', type: 'Ride', name: 'Endurance ride', moving_time: 7200, icu_training_load: 80 },
    { id: 104, category: 'WORKOUT', start_date_local: '2026-11-13T00:00:00', type: 'WeightTraining', name: 'Strength' }, // no duration, no load
    { id: 105, category: 'NOTE', start_date_local: '2026-11-11T00:00:00', name: 'Remember gels' },
  ];
  fake.activities = [
    { id: 'i900', start_date_local: '2026-11-10T07:01:00', start_date: '2026-11-10T06:01:00Z', type: 'Ride', name: 'Morning Ride', moving_time: 7000, elapsed_time: 7300, distance: 61234.5, icu_training_load: 78, average_heartrate: 132, paired_event_id: 103, source: 'GARMIN_CONNECT' },
    { id: 'i901', start_date_local: '2026-11-09T18:00:00', start_date: '2026-11-09T17:00:00Z', type: 'Run', name: 'Unplanned jog', moving_time: 1800, elapsed_time: 1850, distance: 5000, icu_training_load: 0, source: 'UPLOAD' },
    { id: 'i902', start_date_local: '2026-11-08T10:00:00', source: 'STRAVA', _note: 'STRAVA activities are not available via the API' },
  ];
  fake.wellness = [
    { id: '2026-11-10', ctl: 52.3, atl: 61.0, restingHR: 48, hrv: 71.5, sleepSecs: 27000 },
    { id: '2026-11-11', ctl: 52.9, atl: 58.2 }, // no HR / HRV / sleep recorded
  ];
  c = await makeClient(':memory:', true, undefined, (db: DB) => {
    svc = new IntervalsService(db, new IntervalsClient({ athleteId: 'i12345', apiKey: 'secret-key' }, fake.fetch, async () => {}), () => NOW);
    return svc;
  });
});

const summary = async () => (await c.req('GET', '/api/training/summary')).json;
const events = async (from: string, to: string) => ((await c.req('GET', `/api/events?from=${from}&to=${to}`)).json as any[]).filter((e) => e.source === 'intervals');

describe('Intervals.icu import (mocked)', () => {
  it('uses Basic auth with user API_KEY, only GET requests, and the documented endpoints', async () => {
    expect((await c.req('POST', '/api/training/sync')).json.ok).toBe(true);
    expect(fake.log.map((l) => l.path)).toEqual([
      '/api/v1/athlete/i12345/events', '/api/v1/athlete/i12345/activities', '/api/v1/athlete/i12345/wellness',
    ]);
    expect(fake.log[0].auth).toBe(`Basic ${Buffer.from('API_KEY:secret-key').toString('base64')}`);
    expect(fake.log[0].query.get('oldest')).toBe('2026-08-13');
    expect(fake.log[0].query.get('newest')).toBe('2027-01-10');
    const st = (await summary()).status;
    expect(st).toMatchObject({ state: 'ok', athleteId: 'i12345', counts: { planned: 5, activities: 3, wellnessDays: 2 } });
    expect(JSON.stringify(await summary())).not.toContain('secret-key');
  });

  it('repeated imports never duplicate; source edits update in place; source deletions disappear (acceptance 9)', async () => {
    await svc.sync();
    await svc.sync();
    await svc.sync();
    expect(c.db.prepare('SELECT COUNT(*) n FROM intervals_events').get()).toEqual({ n: 5 });
    expect(c.db.prepare('SELECT COUNT(*) n FROM intervals_activities').get()).toEqual({ n: 3 });
    expect(c.db.prepare('SELECT COUNT(*) n FROM intervals_wellness').get()).toEqual({ n: 2 });

    fake.events[0].name = 'Easy run (shortened)';
    fake.events = fake.events.filter((e) => e.id !== 104);
    fake.activities.push({ id: 'i903', start_date_local: '2026-11-11T06:30:00', start_date: '2026-11-11T05:30:00Z', type: 'Run', name: 'Easy run', moving_time: 2650, distance: 7900, icu_training_load: 33, paired_event_id: 101 });
    await svc.sync();
    expect(c.db.prepare('SELECT name FROM intervals_events WHERE id = ?').get('101')).toEqual({ name: 'Easy run (shortened)' });
    expect(c.db.prepare('SELECT COUNT(*) n FROM intervals_events').get()).toEqual({ n: 4 });
    expect(c.db.prepare('SELECT COUNT(*) n FROM intervals_activities').get()).toEqual({ n: 4 });
    // Source ids, units and timestamps are kept as delivered.
    expect(c.db.prepare('SELECT id, distance_m, moving_time_s, start_utc, source FROM intervals_activities WHERE id = ?').get('i900')).toEqual({
      id: 'i900', distance_m: 61234.5, moving_time_s: 7000, start_utc: '2026-11-10T06:01:00.000Z', source: 'GARMIN_CONNECT',
    });
  });

  it('missing values stay "not provided" and are never turned into zero (acceptance 10)', async () => {
    await svc.sync();
    const s = await summary();
    const strength = s.week.planned.find((p: any) => p.name === 'Strength');
    expect(strength).toMatchObject({ durationMin: null, load: null, distanceKm: null });
    // A real zero from the source stays zero.
    expect(s.week.completed.find((a: any) => a.name === 'Unplanned jog').load).toBe(0);
    // Planned week: 4 workouts, one without duration/load -> sums cover 3 and report 1 missing.
    expect(s.week.plannedTotals).toMatchObject({ count: 4, durationMin: { value: 255, missing: 1 }, load: { value: 205, missing: 1 } });
    // Activity whose source hides details: listed, flagged, and not counted as 0 minutes.
    const hidden = (await c.req('GET', '/api/training/summary?weekOf=2026-11-08')).json.week.completed.find((a: any) => a.id === 'i902');
    expect(hidden).toMatchObject({ detailsAvailable: false, durationMin: null, distanceKm: null, load: null });
    const w = Object.fromEntries(s.wellness.map((d: any) => [d.date, d]));
    expect(w['2026-11-10']).toMatchObject({ restingHr: 48, hrv: 71.5, sleepHours: 7.5, form: -8.7 });
    expect(w['2026-11-11']).toMatchObject({ restingHr: null, hrv: null, sleepHours: null, ctl: 52.9 });
  });

  it('planned and completed are reported side by side and a paired workout is not counted twice', async () => {
    await svc.sync();
    const s = await summary();
    expect(s.week.plannedTotals.count).toBe(4);
    expect(s.week.completedTotals).toMatchObject({ count: 2, durationMin: { value: 147, missing: 0 }, distanceKm: { value: 66.23, missing: 0 } });
    expect(s.week.plannedDone).toBe(1); // "Endurance ride" has a paired activity
    expect(s.week.planned.find((p: any) => p.name === 'Endurance ride').done).toBe(true);
    expect(s.todayPlanned.map((p: any) => p.name)).toEqual(['Easy run']);
    expect(s.upcoming.map((p: any) => p.name)).toEqual(['Intervals 4x8', 'Strength']);
    expect(s.recent.map((a: any) => a.name)).toEqual(['Morning Ride', 'Unplanned jog', 'Activity']);

    // Calendar: the paired planned workout is not shown next to its completed activity.
    const tue = await events('2026-11-10', '2026-11-10');
    expect(tue.map((e) => [e.title, e.training.what])).toEqual([['Morning Ride', 'completed']]);
    expect(tue[0]).toMatchObject({ kind: 'training', allDay: false, startAt: '2026-11-10T06:01:00.000Z' });
  });

  it('workouts without a real start time are untimed; ones with a time are placed on the schedule', async () => {
    await svc.sync();
    const wed = await events('2026-11-11', '2026-11-11');
    expect(wed).toHaveLength(1); // the NOTE entry is not a workout
    expect(wed[0]).toMatchObject({ title: 'Easy run', allDay: true, startDate: '2026-11-11', startAt: null, training: { what: 'planned', durationMin: 45, done: false } });
    const thu = await events('2026-11-12', '2026-11-12');
    expect(thu[0]).toMatchObject({ title: 'Intervals 4x8', allDay: false, startAt: '2026-11-12T16:30:00.000Z', endAt: '2026-11-12T18:00:00.000Z' }); // 17:30 Oslo
  });

  it('outages and bad credentials give actionable errors and keep the last import', async () => {
    await svc.sync();
    fake.failNext = 99;
    let r = (await c.req('POST', '/api/training/sync')).json;
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Previously imported training data is still shown/);
    expect(r.status).toMatchObject({ state: 'error', counts: { planned: 5 } });
    expect((await summary()).todayPlanned).toHaveLength(1);
    fake.failNext = 0;
    fake.status = 401;
    r = (await c.req('POST', '/api/training/sync')).json;
    expect(r.error).toMatch(/INTERVALS_API_KEY/);
    fake.status = 200;
    expect((await c.req('POST', '/api/training/sync')).json).toMatchObject({ ok: true, status: { state: 'ok', lastError: null } });
    expect((await c.req('POST', '/api/tasks', { title: 'Local tasks unaffected' })).status).toBe(201);
  });

  it('reports "not configured" without credentials', async () => {
    const plain = await makeClient(':memory:', true, undefined, (db) => new IntervalsService(db, null));
    const s = (await plain.req('GET', '/api/training/summary')).json;
    expect(s.status.state).toBe('not_configured');
    expect(s.week.plannedTotals).toMatchObject({ count: 0, durationMin: { value: null, missing: 0 } });
  });
});
