// Data access. All SQL lives here; inputs are already validated by zod schemas.
import { addDays, dayBounds, diffDays, instantToZoned, todayIn, zonedToInstant } from '../shared/dates';
import { nextInstanceDates } from '../shared/logic';
import {
  DEFAULT_SETTINGS,
  settingsSchema,
  type CalEvent,
  type HistoryEntry,
  type Note,
  type Project,
  type Recurrence,
  type Settings,
  type Subtask,
  type Task,
  type TaskPatch,
} from '../shared/types';
import type { DB } from './db';

export class HttpError extends Error {
  constructor(public status: 400 | 401 | 403 | 404 | 409 | 412 | 429 | 502 | 503, message: string) {
    super(message);
  }
}

const uid = () => crypto.randomUUID();
const nowIso = () => new Date().toISOString();

// ---------- Settings ----------

export function getSettings(db: DB): Settings {
  const row = db.prepare('SELECT json FROM settings WHERE id = 1').get() as { json: string } | undefined;
  if (!row) return DEFAULT_SETTINGS;
  const parsed = settingsSchema.safeParse(JSON.parse(row.json));
  return parsed.success ? parsed.data : DEFAULT_SETTINGS;
}

export function saveSettings(db: DB, s: Settings): Settings {
  db.prepare('INSERT INTO settings (id, json) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json').run(
    JSON.stringify(s),
  );
  return s;
}

// ---------- Projects ----------

const toProject = (r: any): Project => ({
  id: r.id, name: r.name, area: r.area, color: r.color, notes: r.notes, archived: !!r.archived,
});

export function listProjects(db: DB): Project[] {
  return db.prepare('SELECT * FROM projects ORDER BY archived, area, name').all().map(toProject);
}

export function createProject(db: DB, p: { name: string; area: string; color: string; notes: string }): Project {
  const id = uid();
  db.prepare('INSERT INTO projects (id, name, area, color, notes, created_at) VALUES (?,?,?,?,?,?)').run(
    id, p.name, p.area, p.color, p.notes, nowIso(),
  );
  return toProject(db.prepare('SELECT * FROM projects WHERE id = ?').get(id));
}

export function patchProject(db: DB, id: string, p: Partial<Omit<Project, 'id'>>): Project {
  const cur = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
  if (!cur) throw new HttpError(404, 'Project not found');
  const next = { ...toProject(cur), ...p };
  db.prepare('UPDATE projects SET name=?, area=?, color=?, notes=?, archived=? WHERE id=?').run(
    next.name, next.area, next.color, next.notes, next.archived ? 1 : 0, id,
  );
  return next;
}

export function deleteProject(db: DB, id: string): void {
  // Tasks survive: their project_id is set to NULL by the foreign key.
  if (db.prepare('DELETE FROM projects WHERE id = ?').run(id).changes === 0) throw new HttpError(404, 'Project not found');
}

// ---------- Tasks ----------

const toSubtask = (r: any): Subtask => ({ id: r.id, taskId: r.task_id, title: r.title, done: !!r.done, sort: r.sort });

function toTask(r: any, subtasks: Subtask[]): Task {
  return {
    id: r.id,
    seriesId: r.series_id,
    title: r.title,
    notes: r.notes,
    status: r.status,
    priority: r.priority,
    projectId: r.project_id,
    tags: JSON.parse(r.tags),
    estimateMin: r.estimate_min,
    plannedDate: r.planned_date,
    dueDate: r.due_date,
    dueTime: r.due_time,
    focus: !!r.focus,
    recurrence: r.recurrence ? JSON.parse(r.recurrence) : null,
    remindAt: r.remind_at,
    reminderStatus: r.reminder_status,
    completedAt: r.completed_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    subtasks,
  };
}

function withSubtasks(db: DB, rows: any[]): Task[] {
  const by = new Map<string, Subtask[]>();
  for (const s of db.prepare('SELECT * FROM subtasks ORDER BY sort, rowid').all().map(toSubtask)) {
    if (!by.has(s.taskId)) by.set(s.taskId, []);
    by.get(s.taskId)!.push(s);
  }
  return rows.map((r) => toTask(r, by.get(r.id) ?? []));
}

/** Open tasks plus finished ones from the last `doneDays` days (all if null). */
export function listTasks(db: DB, doneDays: number | null = 60): Task[] {
  const rows =
    doneDays == null
      ? db.prepare('SELECT * FROM tasks ORDER BY created_at').all()
      : db
          .prepare("SELECT * FROM tasks WHERE status = 'open' OR updated_at >= ? ORDER BY created_at")
          .all(new Date(Date.now() - doneDays * 864e5).toISOString());
  return withSubtasks(db, rows);
}

export function getTask(db: DB, id: string): Task {
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  if (!row) throw new HttpError(404, 'Task not found');
  const subs = db.prepare('SELECT * FROM subtasks WHERE task_id = ? ORDER BY sort, rowid').all(id).map(toSubtask);
  return toTask(row, subs);
}

function addHistory(db: DB, taskId: string, type: string, data: Record<string, unknown> = {}): void {
  db.prepare('INSERT INTO task_history (id, task_id, type, at, data) VALUES (?,?,?,?,?)').run(
    uid(), taskId, type, nowIso(), JSON.stringify(data),
  );
}

export function taskHistory(db: DB, taskId: string): HistoryEntry[] {
  const task = getTask(db, taskId);
  const ids = task.seriesId
    ? db.prepare('SELECT id FROM tasks WHERE series_id = ?').all(task.seriesId).map((r: any) => r.id)
    : [taskId];
  return db
    .prepare(`SELECT * FROM task_history WHERE task_id IN (${ids.map(() => '?').join(',')}) ORDER BY at DESC LIMIT 200`)
    .all(...ids)
    .map((r: any) => ({ id: r.id, taskId: r.task_id, type: r.type, at: r.at, data: JSON.parse(r.data) }));
}

/** Monthly/yearly rules remember the anchor day so short months do not cause drift. */
function normaliseRecurrence(r: Recurrence | null, anchor: string | null): Recurrence | null {
  if (!r) return null;
  if (!anchor) throw new HttpError(400, 'A recurring task needs a planned day or a deadline');
  if ((r.freq === 'monthly' || r.freq === 'yearly') && !r.dayOfMonth) return { ...r, dayOfMonth: Number(anchor.slice(8, 10)) };
  return r;
}

interface TaskInsert {
  title: string; notes: string; priority: number; projectId: string | null; tags: string[];
  estimateMin: number | null; plannedDate: string | null; dueDate: string | null; dueTime: string | null;
  focus: boolean; recurrence: Recurrence | null; remindAt: string | null; subtasks: string[];
  seriesId?: string | null;
}

export function createTask(db: DB, t: TaskInsert): Task {
  if (t.dueTime && !t.dueDate) throw new HttpError(400, 'A deadline time needs a deadline date');
  if (t.projectId && !db.prepare('SELECT 1 FROM projects WHERE id = ?').get(t.projectId)) throw new HttpError(400, 'Unknown project');
  const recurrence = normaliseRecurrence(t.recurrence, t.plannedDate ?? t.dueDate);
  const id = uid();
  const ts = nowIso();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO tasks (id, series_id, title, notes, priority, project_id, tags, estimate_min, planned_date,
        due_date, due_time, focus, recurrence, remind_at, reminder_status, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      id, t.seriesId ?? (recurrence ? id : null), t.title, t.notes, t.priority, t.projectId, JSON.stringify(t.tags),
      t.estimateMin, t.plannedDate, t.dueDate, t.dueTime, t.focus ? 1 : 0,
      recurrence ? JSON.stringify(recurrence) : null, t.remindAt, t.remindAt ? 'pending' : 'none', ts, ts,
    );
    const ins = db.prepare('INSERT INTO subtasks (id, task_id, title, sort) VALUES (?,?,?,?)');
    t.subtasks.forEach((title, i) => ins.run(uid(), id, title, i));
    addHistory(db, id, 'created');
  })();
  return getTask(db, id);
}

/**
 * Partial update. Only the fields present in the patch change - in particular,
 * changing plannedDate never touches dueDate/dueTime.
 */
export function patchTask(db: DB, id: string, patch: TaskPatch): Task {
  const cur = getTask(db, id);
  const next = { ...cur, ...patch };
  if (patch.dueDate === null) next.dueTime = null;
  if (next.dueTime && !next.dueDate) throw new HttpError(400, 'A deadline time needs a deadline date');
  if (patch.projectId && !db.prepare('SELECT 1 FROM projects WHERE id = ?').get(patch.projectId)) throw new HttpError(400, 'Unknown project');
  const recurrence = normaliseRecurrence(
    'recurrence' in patch && patch.recurrence ? { ...patch.recurrence, dayOfMonth: undefined } : next.recurrence,
    next.plannedDate ?? next.dueDate,
  );
  const reminderStatus =
    'remindAt' in patch ? (patch.remindAt ? 'pending' : 'none') : cur.reminderStatus;
  db.transaction(() => {
    db.prepare(
      `UPDATE tasks SET series_id=?, title=?, notes=?, priority=?, project_id=?, tags=?, estimate_min=?, planned_date=?,
        due_date=?, due_time=?, focus=?, recurrence=?, remind_at=?, reminder_status=?, updated_at=? WHERE id=?`,
    ).run(
      cur.seriesId ?? (recurrence ? id : null), next.title, next.notes, next.priority, next.projectId,
      JSON.stringify(next.tags), next.estimateMin, next.plannedDate, next.dueDate, next.dueTime, next.focus ? 1 : 0,
      recurrence ? JSON.stringify(recurrence) : null, next.remindAt, reminderStatus, nowIso(), id,
    );
    if ('plannedDate' in patch && patch.plannedDate !== cur.plannedDate) {
      addHistory(db, id, 'rescheduled', { from: cur.plannedDate, to: patch.plannedDate ?? null });
    }
    if ('dueDate' in patch && patch.dueDate !== cur.dueDate) {
      addHistory(db, id, 'deadline_changed', { from: cur.dueDate, to: patch.dueDate ?? null });
    }
  })();
  return getTask(db, id);
}

/**
 * Complete or dismiss. The finished row is kept as-is (history is preserved); a
 * recurring task gets a NEW row for its next instance in the same series.
 */
export function finishTask(db: DB, id: string, status: 'done' | 'dismissed'): { task: Task; next: Task | null } {
  const cur = getTask(db, id);
  if (cur.status !== 'open') return { task: cur, next: null };
  const tz = getSettings(db).timezone;
  let nextId: string | null = null;
  db.transaction(() => {
    const ts = nowIso();
    db.prepare('UPDATE tasks SET status=?, completed_at=?, focus=0, updated_at=? WHERE id=?').run(status, ts, ts, id);
    if (cur.recurrence && cur.seriesId) {
      const openSibling = db
        .prepare("SELECT 1 FROM tasks WHERE series_id = ? AND status = 'open' AND id != ?")
        .get(cur.seriesId, id);
      const dates = openSibling ? null : nextInstanceDates(cur.recurrence, cur.plannedDate, cur.dueDate, todayIn(tz));
      if (dates) {
        const anchor = (cur.plannedDate ?? cur.dueDate)!;
        const shift = diffDays(anchor, (dates.plannedDate ?? dates.dueDate)!);
        let remindAt: string | null = null;
        if (cur.remindAt) {
          const z = instantToZoned(cur.remindAt, tz);
          remindAt = zonedToInstant(addDays(z.date, shift), z.time, tz);
        }
        nextId = createTask(db, {
          title: cur.title, notes: cur.notes, priority: cur.priority, projectId: cur.projectId, tags: cur.tags,
          estimateMin: cur.estimateMin, plannedDate: dates.plannedDate, dueDate: dates.dueDate, dueTime: cur.dueTime,
          focus: false, recurrence: cur.recurrence, remindAt, subtasks: cur.subtasks.map((s) => s.title),
          seriesId: cur.seriesId,
        }).id;
      }
    }
    addHistory(db, id, status === 'done' ? 'completed' : 'dismissed', nextId ? { nextInstanceId: nextId } : {});
  })();
  return { task: getTask(db, id), next: nextId ? getTask(db, nextId) : null };
}

export function reopenTask(db: DB, id: string): Task {
  const cur = getTask(db, id);
  if (cur.status === 'open') return cur;
  db.transaction(() => {
    db.prepare("UPDATE tasks SET status='open', completed_at=NULL, updated_at=? WHERE id=?").run(nowIso(), id);
    addHistory(db, id, 'reopened');
  })();
  return getTask(db, id);
}

export function deleteTask(db: DB, id: string): void {
  if (db.prepare('DELETE FROM tasks WHERE id = ?').run(id).changes === 0) throw new HttpError(404, 'Task not found');
}

export function addSubtask(db: DB, taskId: string, title: string): Task {
  getTask(db, taskId);
  const sort = (db.prepare('SELECT COALESCE(MAX(sort), -1) + 1 AS n FROM subtasks WHERE task_id = ?').get(taskId) as any).n;
  db.prepare('INSERT INTO subtasks (id, task_id, title, sort) VALUES (?,?,?,?)').run(uid(), taskId, title, sort);
  return getTask(db, taskId);
}

export function patchSubtask(db: DB, id: string, p: { title?: string; done?: boolean }): Task {
  const cur = db.prepare('SELECT * FROM subtasks WHERE id = ?').get(id) as any;
  if (!cur) throw new HttpError(404, 'Subtask not found');
  db.prepare('UPDATE subtasks SET title=?, done=? WHERE id=?').run(p.title ?? cur.title, (p.done ?? !!cur.done) ? 1 : 0, id);
  return getTask(db, cur.task_id);
}

export function deleteSubtask(db: DB, id: string): Task {
  const cur = db.prepare('SELECT task_id FROM subtasks WHERE id = ?').get(id) as any;
  if (!cur) throw new HttpError(404, 'Subtask not found');
  db.prepare('DELETE FROM subtasks WHERE id = ?').run(id);
  return getTask(db, cur.task_id);
}

// ---------- Reminders ----------

export function dueReminders(db: DB): Task[] {
  const rows = db
    .prepare("SELECT * FROM tasks WHERE status = 'open' AND reminder_status = 'pending' AND remind_at <= ?")
    .all(nowIso());
  return withSubtasks(db, rows);
}

export function ackReminder(db: DB, taskId: string, status: 'delivered' | 'failed'): void {
  db.prepare("UPDATE tasks SET reminder_status = ? WHERE id = ? AND reminder_status = 'pending'").run(status, taskId);
}

// ---------- Events and time blocks ----------

const EVENT_SELECT = `SELECT e.*, t.title AS task_title, mc.summary AS mirror_cal,
    (SELECT summary FROM google_calendars WHERE is_mirror = 1) AS mirror_target
  FROM events e LEFT JOIN tasks t ON t.id = e.task_id LEFT JOIN google_calendars mc ON mc.id = e.mirror_calendar_id`;

const toEvent = (r: any): CalEvent => ({
  id: r.id,
  kind: r.kind,
  taskId: r.task_id,
  title: r.kind === 'task_block' ? (r.task_title ?? '') : r.title,
  notes: r.notes,
  location: r.location,
  allDay: !!r.all_day,
  startDate: r.start_date,
  endDate: r.end_date,
  startAt: r.start_at,
  endAt: r.end_at,
  source: 'app',
  updatedAt: r.updated_at,
  ...(r.kind === 'task_block' && (r.mirror_event_id || r.mirror_error || r.mirror_target)
    ? {
        mirror: {
          state: r.mirror_error ? ('failed' as const) : r.mirror_event_id ? ('synced' as const) : ('pending' as const),
          calendarName: r.mirror_cal ?? r.mirror_target ?? null,
          error: r.mirror_error ?? null,
        },
      }
    : {}),
});

export function getEvent(db: DB, id: string): CalEvent {
  const row = db.prepare(`${EVENT_SELECT} WHERE e.id = ?`).get(id);
  if (!row) throw new HttpError(404, 'Event not found');
  return toEvent(row);
}

/** Events overlapping the inclusive date range [from, to] in the user's timezone. */
export function listEvents(db: DB, from: string, to: string): CalEvent[] {
  const tz = getSettings(db).timezone;
  const start = dayBounds(from, tz).start;
  const end = dayBounds(to, tz).end;
  return db
    .prepare(
      `${EVENT_SELECT}
       WHERE (e.all_day = 0 AND e.start_at < ? AND e.end_at > ?)
          OR (e.all_day = 1 AND e.start_date <= ? AND e.end_date >= ?)
       ORDER BY COALESCE(e.start_at, e.start_date)`,
    )
    .all(end, start, to, from)
    .map(toEvent);
}

export function listTaskBlocks(db: DB, taskId: string): CalEvent[] {
  return db.prepare(`${EVENT_SELECT} WHERE e.task_id = ? ORDER BY e.start_at`).all(taskId).map(toEvent);
}

type EventInput =
  | { allDay: true; title: string; notes: string; location: string; startDate: string; endDate: string }
  | { allDay: false; title: string; notes: string; location: string; startAt: string; endAt: string };

export function createEvent(db: DB, e: EventInput): CalEvent {
  const id = uid();
  const ts = nowIso();
  db.prepare(
    `INSERT INTO events (id, kind, title, notes, location, all_day, start_date, end_date, start_at, end_at, created_at, updated_at)
     VALUES (?, 'event', ?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id, e.title, e.notes, e.location, e.allDay ? 1 : 0,
    e.allDay ? e.startDate : null, e.allDay ? e.endDate : null,
    e.allDay ? null : e.startAt, e.allDay ? null : e.endAt, ts, ts,
  );
  return getEvent(db, id);
}

/** The task's planned day follows its block when it has only that one block. Deadline is never touched. */
function syncPlannedDay(db: DB, taskId: string, startAt: string): void {
  const count = (db.prepare('SELECT COUNT(*) AS n FROM events WHERE task_id = ?').get(taskId) as any).n;
  if (count !== 1) return;
  const day = instantToZoned(startAt, getSettings(db).timezone).date;
  const task = getTask(db, taskId);
  if (task.plannedDate !== day) patchTask(db, taskId, { plannedDate: day });
}

/** Creates a time block linked to an existing task. The task row is not copied. */
export function scheduleTask(db: DB, taskId: string, startAt: string, endAt: string): CalEvent {
  getTask(db, taskId);
  const id = uid();
  const ts = nowIso();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO events (id, kind, task_id, all_day, start_at, end_at, created_at, updated_at)
       VALUES (?, 'task_block', ?, 0, ?, ?, ?, ?)`,
    ).run(id, taskId, startAt, endAt, ts, ts);
    syncPlannedDay(db, taskId, startAt);
  })();
  return getEvent(db, id);
}

export function patchEvent(
  db: DB,
  id: string,
  p: Partial<{ title: string; notes: string; location: string; startDate: string; endDate: string; startAt: string; endAt: string }>,
): CalEvent {
  const cur = getEvent(db, id);
  const next = { ...cur, ...p };
  if (cur.allDay) {
    if (p.startAt || p.endAt) throw new HttpError(400, 'All-day events use startDate/endDate');
    if (next.endDate! < next.startDate!) throw new HttpError(400, 'End date is before start date');
  } else {
    if (p.startDate || p.endDate) throw new HttpError(400, 'Timed events use startAt/endAt');
    if (next.endAt! <= next.startAt!) throw new HttpError(400, 'End must be after start');
  }
  db.transaction(() => {
    db.prepare(
      'UPDATE events SET title=?, notes=?, location=?, start_date=?, end_date=?, start_at=?, end_at=?, updated_at=? WHERE id=?',
    ).run(
      cur.kind === 'task_block' ? '' : next.title, next.notes, next.location,
      next.startDate, next.endDate, next.startAt, next.endAt, nowIso(), id,
    );
    if (cur.kind === 'task_block' && cur.taskId && p.startAt) syncPlannedDay(db, cur.taskId, next.startAt!);
  })();
  return getEvent(db, id);
}

/** Deleting a time block only removes the block; the linked task stays. */
export function deleteEvent(db: DB, id: string): void {
  if (db.prepare('DELETE FROM events WHERE id = ?').run(id).changes === 0) throw new HttpError(404, 'Event not found');
}

// ---------- Notes ----------

const toNote = (r: any): Note => ({ id: r.id, body: r.body, taskId: r.task_id, projectId: r.project_id, createdAt: r.created_at });

export function listNotes(db: DB): Note[] {
  return db.prepare('SELECT * FROM notes ORDER BY created_at DESC').all().map(toNote);
}

export function createNote(db: DB, n: { body: string; taskId: string | null; projectId: string | null }): Note {
  const id = uid();
  db.prepare('INSERT INTO notes (id, body, task_id, project_id, created_at) VALUES (?,?,?,?,?)').run(
    id, n.body, n.taskId, n.projectId, nowIso(),
  );
  return toNote(db.prepare('SELECT * FROM notes WHERE id = ?').get(id));
}

export function deleteNote(db: DB, id: string): void {
  if (db.prepare('DELETE FROM notes WHERE id = ?').run(id).changes === 0) throw new HttpError(404, 'Note not found');
}

// ---------- Export ----------

export function exportAll(db: DB) {
  const all = (t: string) => db.prepare(`SELECT * FROM ${t}`).all();
  return {
    format: 'claudedashboard-export',
    version: 1,
    exportedAt: nowIso(),
    settings: getSettings(db),
    projects: all('projects'),
    tasks: all('tasks'),
    subtasks: all('subtasks'),
    taskHistory: all('task_history'),
    events: all('events'),
    notes: all('notes'),
  };
}
