// Demo mode: sample data in its OWN database file (data/demo.db). It never reads or
// writes the real database, and no integration makes a network call.
import { createUser, hasUser } from './auth';
import type { DB } from './db';
import { addDays, addMinutes, todayIn, zonedToInstant } from '../shared/dates';
import * as repo from './repo';

export const DEMO_USER = { username: 'demo', password: 'demo-password' };

export function seedDemo(db: DB): void {
  if (hasUser(db)) return; // already seeded
  createUser(db, DEMO_USER.username, DEMO_USER.password);
  const tz = repo.getSettings(db).timezone;
  const today = todayIn(tz);
  const d = (n: number) => addDays(today, n);
  const at = (n: number, t: string) => zonedToInstant(d(n), t, tz);
  const now = new Date().toISOString();

  const work = repo.createProject(db, { name: 'Website relaunch', area: 'Work', color: '#5b7c99', notes: 'Launch planned for the end of the month.' });
  const home = repo.createProject(db, { name: 'Home', area: 'Personal', color: '#a06a3b', notes: '' });
  const base = { notes: '', priority: 0, projectId: null as string | null, tags: [] as string[], estimateMin: null as number | null, plannedDate: null as string | null, dueDate: null as string | null, dueTime: null as string | null, focus: false, recurrence: null, remindAt: null, subtasks: [] as string[] };
  const t1 = repo.createTask(db, { ...base, title: 'Draft launch announcement', plannedDate: d(0), dueDate: d(2), priority: 3, estimateMin: 90, projectId: work.id, focus: true, subtasks: ['Outline', 'First draft', 'Review with Kari'] });
  repo.createTask(db, { ...base, title: 'Renew passport', plannedDate: d(0), dueDate: d(9), estimateMin: 30, tags: ['admin'] });
  repo.createTask(db, { ...base, title: 'Book dentist', plannedDate: d(-2), projectId: home.id });
  repo.createTask(db, { ...base, title: 'Send invoice', dueDate: d(-1), priority: 2 });
  repo.createTask(db, { ...base, title: 'Water plants', plannedDate: d(1), recurrence: { freq: 'weekly', interval: 1 }, projectId: home.id });
  repo.createTask(db, { ...base, title: 'Read contract', plannedDate: d(2), dueDate: d(4), dueTime: '15:00' });
  repo.createTask(db, { ...base, title: 'Idea: garden shed' });
  const t2 = repo.createTask(db, { ...base, title: 'Review pull requests', plannedDate: d(0), estimateMin: 45, projectId: work.id });
  repo.scheduleTask(db, t2.id, at(0, '13:00'), at(0, '13:45'));
  repo.createEvent(db, { allDay: false, title: 'Lunch with Kari', notes: '', location: 'Café', startAt: at(1, '11:30'), endAt: at(1, '12:30') });
  repo.createNote(db, { body: 'Ask about the parking permit', taskId: null, projectId: null });
  repo.createNote(db, { body: 'Tone: friendly, short, one clear call to action.', taskId: t1.id, projectId: null });
  repo.createNote(db, { body: 'Stakeholders want a preview by Thursday.', taskId: null, projectId: work.id });

  // A pretend Google account. Status 'demo' means it is never contacted.
  db.prepare("INSERT INTO google_accounts (id, label, refresh_token_enc, scopes, status, connected_at) VALUES ('demo', 'demo@example.com', 'demo', '', 'demo', ?)").run(now);
  const cal = db.prepare('INSERT INTO google_calendars (id, account_id, google_id, summary, color, access_role, is_primary, selected, is_default) VALUES (?,?,?,?,?,?,?,1,?)');
  cal.run('demo-personal', 'demo', 'demo@example.com', 'Personal (demo)', '#1a73e8', 'owner', 1, 0);
  cal.run('demo-team', 'demo', 'team@example.com', 'Team (demo, read-only)', '#d50000', 'reader', 0, 0);
  const ev = db.prepare(
    `INSERT INTO google_events (calendar_id, id, summary, location, all_day, start_date, end_date, start_at, end_at, recurring_event_id, event_type, can_edit, fetched_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,'default',?,?)`,
  );
  for (let i = -1; i <= 5; i++) ev.run('demo-team', `standup_${i}`, 'Team stand-up', '', 0, null, null, at(i, '09:00'), at(i, '09:15'), 'standup', 0, now);
  ev.run('demo-team', 'review', 'Design review', 'Room 2', 0, null, null, at(0, '13:30'), at(0, '14:30'), null, 0, now);
  ev.run('demo-personal', 'conf', 'Conference', '', 1, d(3), d(4), null, null, null, 1, now);
  ev.run('demo-personal', 'dinner', 'Dinner with parents', '', 0, null, null, at(2, '18:00'), at(2, '20:00'), null, 1, now);
  ev.run('demo-personal', 'run-dup', 'Easy run', '', 0, null, null, at(1, '07:00'), at(1, '07:45'), null, 1, now); // also exists as a planned workout

  // Pretend Intervals.icu data.
  db.prepare("INSERT INTO intervals_state (id, athlete_id, last_synced_at, demo) VALUES (1, 'demo', ?, 1)").run(now);
  const pe = db.prepare('INSERT INTO intervals_events (id, category, start_local, date, has_time, type, name, moving_time_s, distance_m, load, fetched_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
  pe.run('p1', 'WORKOUT', `${d(0)}T00:00:00`, d(0), 0, 'Ride', 'Endurance ride', 5400, null, 65, now);
  pe.run('p2', 'WORKOUT', `${d(1)}T07:00:00`, d(1), 1, 'Run', 'Easy run', 2700, 8000, 35, now);
  pe.run('p3', 'WORKOUT', `${d(3)}T00:00:00`, d(3), 0, 'Ride', 'Intervals 4x8 min', 4500, null, 85, now);
  pe.run('p4', 'WORKOUT', `${d(4)}T00:00:00`, d(4), 0, 'WeightTraining', 'Strength', null, null, null, now);
  pe.run('p0', 'WORKOUT', `${d(-1)}T00:00:00`, d(-1), 0, 'Run', 'Tempo run', 3000, 10000, 60, now);
  const ac = db.prepare(
    'INSERT INTO intervals_activities (id, start_local, start_utc, date, type, name, moving_time_s, elapsed_time_s, distance_m, load, avg_hr, source, paired_event_id, fetched_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
  );
  ac.run('a1', `${d(-1)}T17:30:00`, at(-1, '17:30'), d(-1), 'Run', 'Tempo run', 2950, 3100, 9900, 58, 156, 'GARMIN_CONNECT', 'p0', now);
  ac.run('a2', `${d(-3)}T06:45:00`, at(-3, '06:45'), d(-3), 'Ride', 'Morning ride', 6100, 6400, 52000, 72, 131, 'GARMIN_CONNECT', null, now);
  ac.run('a3', `${d(-5)}T18:00:00`, at(-5, '18:00'), d(-5), 'Run', 'Recovery jog', 1800, 1850, 5000, 18, null, 'UPLOAD', null, now);
  const we = db.prepare('INSERT INTO intervals_wellness (date, ctl, atl, resting_hr, hrv, sleep_secs, fetched_at) VALUES (?,?,?,?,?,?,?)');
  for (let i = -13; i <= 0; i++) {
    const k = i + 13;
    // Two days deliberately have no sleep/HRV recorded, to show "not recorded" in the UI.
    const gap = k === 4 || k === 9;
    we.run(d(i), 48 + k * 0.4, 50 + ((k * 7) % 11), gap ? null : 46 + (k % 4), gap ? null : 62 + ((k * 5) % 14), gap ? null : 25200 + ((k * 900) % 5400), now);
  }
  void addMinutes;
}
