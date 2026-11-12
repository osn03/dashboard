// Pure task/calendar logic shared by server, client and tests.
import { DateTime } from 'luxon';
import {
  addDays,
  dayBounds,
  diffDays,
  instantToZoned,
  timeToMinutes,
  weekdayOf,
  zonedToInstant,
  type DateStr,
  type Instant,
} from './dates';
import type { CalEvent, Recurrence, Settings, Task } from './types';

// ---------- Deadlines ----------

/** Deadline passed? Date-only deadlines are overdue only once the whole day is over. */
export function isOverdue(t: Pick<Task, 'status' | 'dueDate' | 'dueTime'>, now: Date, tz: string): boolean {
  if (t.status !== 'open' || !t.dueDate) return false;
  if (t.dueTime) return Date.parse(zonedToInstant(t.dueDate, t.dueTime, tz)) < now.getTime();
  return t.dueDate < DateTime.fromJSDate(now, { zone: tz }).toISODate()!;
}

/** Planned for a past day and still open (and not already counted as overdue). */
export function isMissed(t: Pick<Task, 'status' | 'plannedDate'>, today: DateStr): boolean {
  return t.status === 'open' && !!t.plannedDate && t.plannedDate < today;
}

export function compareTasks(a: Task, b: Task): number {
  if (a.focus !== b.focus) return a.focus ? -1 : 1;
  if (a.priority !== b.priority) return b.priority - a.priority;
  const ad = a.dueDate ? a.dueDate + (a.dueTime ?? '99:99') : '9999';
  const bd = b.dueDate ? b.dueDate + (b.dueTime ?? '99:99') : '9999';
  if (ad !== bd) return ad < bd ? -1 : 1;
  return a.createdAt < b.createdAt ? -1 : 1;
}

export interface TaskBuckets {
  inbox: Task[];
  today: Task[];
  missed: Task[];
  overdue: Task[];
  upcoming: Task[];
  dueSoon: Task[];
}

export function bucketTasks(tasks: Task[], now: Date, tz: string, soonDays = 14): TaskBuckets {
  const today = DateTime.fromJSDate(now, { zone: tz }).toISODate()!;
  const open = tasks.filter((t) => t.status === 'open');
  const overdue = open.filter((t) => isOverdue(t, now, tz));
  const overdueIds = new Set(overdue.map((t) => t.id));
  const soonLimit = addDays(today, soonDays);
  return {
    inbox: open.filter((t) => !t.plannedDate && !t.projectId).sort(compareTasks),
    today: open
      .filter((t) => t.plannedDate === today || (t.dueDate === today && !overdueIds.has(t.id) && !t.plannedDate))
      .sort(compareTasks),
    missed: open.filter((t) => isMissed(t, today) && !overdueIds.has(t.id)).sort(compareTasks),
    overdue: overdue.sort(compareTasks),
    upcoming: open
      .filter((t) => (t.plannedDate && t.plannedDate > today) || (t.dueDate && t.dueDate > today))
      .sort((a, b) => {
        const ak = upcomingKey(a, today);
        const bk = upcomingKey(b, today);
        return ak === bk ? compareTasks(a, b) : ak < bk ? -1 : 1;
      }),
    dueSoon: open
      .filter((t) => t.dueDate && !overdueIds.has(t.id) && t.dueDate >= today && t.dueDate <= soonLimit)
      .sort((a, b) => ((a.dueDate! + (a.dueTime ?? '')) < (b.dueDate! + (b.dueTime ?? '')) ? -1 : 1)),
  };
}

/** The date an upcoming task is listed under: next of planned day / deadline that is after today. */
export function upcomingKey(t: Task, today: DateStr): DateStr {
  const c = [t.plannedDate, t.dueDate].filter((d): d is string => !!d && d > today).sort();
  return c[0] ?? '9999-12-31';
}

/** Up to three priorities: user-starred first, then suggestions (flagged as such). */
export function topPriorities(tasks: Task[], now: Date, tz: string): { task: Task; suggested: boolean }[] {
  const today = DateTime.fromJSDate(now, { zone: tz }).toISODate()!;
  const open = tasks.filter((t) => t.status === 'open');
  const starred = open.filter((t) => t.focus).sort(compareTasks).slice(0, 3);
  const out = starred.map((task) => ({ task, suggested: false }));
  if (out.length < 3) {
    const picked = new Set(starred.map((t) => t.id));
    const candidates = open
      .filter(
        (t) =>
          !picked.has(t.id) &&
          (isOverdue(t, now, tz) || t.plannedDate === today || t.dueDate === today || isMissed(t, today)),
      )
      .sort((a, b) => {
        const ao = isOverdue(a, now, tz) ? 0 : 1;
        const bo = isOverdue(b, now, tz) ? 0 : 1;
        return ao !== bo ? ao - bo : compareTasks(a, b);
      });
    for (const task of candidates.slice(0, 3 - out.length)) out.push({ task, suggested: true });
  }
  return out;
}

// ---------- Recurrence ----------

function clampDay(year: number, month: number, day: number): DateStr {
  const dim = DateTime.utc(year, month, 1).daysInMonth!;
  return DateTime.utc(year, month, Math.min(day, dim)).toISODate()!;
}

/** Next occurrence strictly after `anchor`. */
export function nextOccurrence(rule: Recurrence, anchor: DateStr): DateStr {
  const interval = Math.max(1, rule.interval ?? 1);
  const a = DateTime.fromISO(anchor, { zone: 'utc' });
  switch (rule.freq) {
    case 'daily':
      return addDays(anchor, interval);
    case 'weekly': {
      const days = rule.weekdays?.length ? [...rule.weekdays].sort() : [a.weekday];
      // Remaining weekdays in the current week first, then jump `interval` weeks.
      const later = days.find((d) => d > a.weekday);
      if (later) return addDays(anchor, later - a.weekday);
      const monday = addDays(anchor, -(a.weekday - 1));
      return addDays(monday, interval * 7 + (days[0] - 1));
    }
    case 'monthly': {
      const day = rule.dayOfMonth ?? a.day;
      const m = a.startOf('month').plus({ months: interval });
      return clampDay(m.year, m.month, day);
    }
    case 'yearly': {
      const day = rule.dayOfMonth ?? a.day;
      return clampDay(a.year + interval, a.month, day);
    }
  }
}

/**
 * Dates for the next instance of a recurring task. The planned-day/deadline gap
 * is preserved. A late completion never creates instances in the past.
 */
export function nextInstanceDates(
  rule: Recurrence,
  plannedDate: DateStr | null,
  dueDate: DateStr | null,
  completedOn: DateStr,
): { plannedDate: DateStr | null; dueDate: DateStr | null } | null {
  const anchor = plannedDate ?? dueDate;
  if (!anchor) return null;
  let next = nextOccurrence(rule, anchor);
  for (let i = 0; i < 5000 && next < completedOn; i++) next = nextOccurrence(rule, next);
  const shift = diffDays(anchor, next);
  return {
    plannedDate: plannedDate ? addDays(plannedDate, shift) : null,
    dueDate: dueDate ? addDays(dueDate, shift) : null,
  };
}

export function describeRecurrence(r: Recurrence): string {
  const n = r.interval ?? 1;
  const unit = { daily: 'day', weekly: 'week', monthly: 'month', yearly: 'year' }[r.freq];
  let s = n === 1 ? `Every ${unit}` : `Every ${n} ${unit}s`;
  if (r.freq === 'weekly' && r.weekdays?.length) {
    const names = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    s += ' on ' + [...r.weekdays].sort().map((d) => names[d - 1]).join(', ');
  }
  return s;
}

// ---------- Calendar ----------

export interface DaySegment {
  event: CalEvent;
  /** Wall-clock minutes from local midnight, clipped to this day. */
  startMin: number;
  endMin: number;
  continuesBefore: boolean;
  continuesAfter: boolean;
}

/** Timed events that touch `date`, clipped to that day, positioned by wall-clock time. */
export function segmentsForDay(events: CalEvent[], date: DateStr, tz: string): DaySegment[] {
  const { start, end } = dayBounds(date, tz);
  const out: DaySegment[] = [];
  for (const event of events) {
    if (event.allDay || !event.startAt || !event.endAt) continue;
    if (event.endAt <= start || event.startAt >= end) continue;
    const before = event.startAt < start;
    const after = event.endAt > end;
    const startMin = before ? 0 : timeToMinutes(instantToZoned(event.startAt, tz).time);
    const endMin = after || event.endAt === end ? 1440 : timeToMinutes(instantToZoned(event.endAt, tz).time);
    out.push({ event, startMin, endMin: Math.max(endMin, startMin + 1), continuesBefore: before, continuesAfter: after });
  }
  return out.sort((a, b) => a.startMin - b.startMin || b.endMin - a.endMin);
}

export interface LaidOut extends DaySegment {
  col: number;
  cols: number;
  conflict: boolean;
}

/** Side-by-side column layout for overlapping segments; overlapping items are flagged. */
export function layoutSegments(segs: DaySegment[]): LaidOut[] {
  const out: LaidOut[] = [];
  let cluster: LaidOut[] = [];
  let clusterEnd = -1;
  const flush = () => {
    const cols = Math.max(0, ...cluster.map((c) => c.col)) + 1;
    for (const c of cluster) {
      c.cols = cols;
      c.conflict = cluster.some((o) => o !== c && o.startMin < c.endMin && c.startMin < o.endMin);
    }
    out.push(...cluster);
    cluster = [];
  };
  for (const s of segs) {
    if (cluster.length && s.startMin >= clusterEnd) flush();
    const used = new Set(cluster.filter((c) => c.endMin > s.startMin).map((c) => c.col));
    let col = 0;
    while (used.has(col)) col++;
    cluster.push({ ...s, col, cols: 1, conflict: false });
    clusterEnd = Math.max(clusterEnd, s.endMin);
  }
  if (cluster.length) flush();
  return out;
}

/** All-day calendar events on a date. Untimed training is a separate area, see untimedTrainingFor. */
export function allDayEventsFor(events: CalEvent[], date: DateStr): CalEvent[] {
  return events.filter((e) => e.allDay && e.kind !== 'training' && e.startDate! <= date && e.endDate! >= date);
}

/** Training without a real start time (planned workouts, or activities with no time) on a date. */
export function untimedTrainingFor(events: CalEvent[], date: DateStr): CalEvent[] {
  return events.filter((e) => e.allDay && e.kind === 'training' && e.startDate === date);
}

/** Untimed tasks for a day: planned that day and not already placed in that day's timed schedule. */
export function untimedTasksFor(tasks: Task[], events: CalEvent[], date: DateStr, tz: string): Task[] {
  const { start, end } = dayBounds(date, tz);
  const blocked = new Set(
    events
      .filter((e) => e.kind === 'task_block' && e.taskId && e.startAt! < end && e.endAt! > start)
      .map((e) => e.taskId),
  );
  return tasks
    .filter((t) => t.plannedDate === date && t.status !== 'dismissed' && !blocked.has(t.id))
    .sort((a, b) => (a.status !== b.status ? (a.status === 'open' ? -1 : 1) : compareTasks(a, b)));
}

/** Tasks whose deadline falls on `date` but which are planned for another day (or unplanned). */
export function deadlinesOn(tasks: Task[], date: DateStr): Task[] {
  return tasks.filter((t) => t.status === 'open' && t.dueDate === date && t.plannedDate !== date);
}

// ---------- Available time ----------

export interface TimeSummary {
  isWorkDay: boolean;
  /** Working window still ahead (from now if today), in minutes. */
  windowMin: number;
  committedMin: number;
  freeMin: number;
  /** Sum of estimates of open untimed tasks for the day. */
  estimatedMin: number;
  unestimatedCount: number;
  /** freeMin - estimatedMin; negative means over-planned. */
  balanceMin: number;
  freeSlots: { start: Instant; end: Instant }[];
}

/**
 * Realistic free time inside working hours: the remaining working window minus the
 * union of timed commitments (events and task blocks; overlaps are not double-counted).
 */
export function timeSummary(
  date: DateStr,
  tasks: Task[],
  events: CalEvent[],
  settings: Pick<Settings, 'timezone' | 'workStart' | 'workEnd' | 'workDays'>,
  now: Date,
): TimeSummary {
  const tz = settings.timezone;
  const isWorkDay = settings.workDays.includes(weekdayOf(date));
  let winStart = Date.parse(zonedToInstant(date, settings.workStart, tz));
  const winEnd = Date.parse(zonedToInstant(date, settings.workEnd, tz));
  const today = DateTime.fromJSDate(now, { zone: tz }).toISODate()!;
  if (date === today) winStart = Math.max(winStart, now.getTime());
  if (date < today) winStart = winEnd;

  const busy = events
    .filter((e) => !e.allDay && e.startAt && e.endAt)
    .filter((e) => !(e.kind === 'task_block' && tasks.find((t) => t.id === e.taskId)?.status === 'done'))
    .map((e) => [Math.max(Date.parse(e.startAt!), winStart), Math.min(Date.parse(e.endAt!), winEnd)] as [number, number])
    .filter(([s, e]) => e > s)
    .sort((a, b) => a[0] - b[0]);

  const merged: [number, number][] = [];
  for (const iv of busy) {
    const last = merged[merged.length - 1];
    if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]);
    else merged.push([...iv]);
  }
  const windowMin = isWorkDay ? Math.max(0, Math.round((winEnd - winStart) / 60000)) : 0;
  const committedMin = isWorkDay ? Math.round(merged.reduce((s, [a, b]) => s + (b - a), 0) / 60000) : 0;

  const freeSlots: { start: Instant; end: Instant }[] = [];
  if (isWorkDay) {
    let cursor = winStart;
    for (const [s, e] of merged) {
      if (s - cursor >= 15 * 60000) freeSlots.push({ start: new Date(cursor).toISOString(), end: new Date(s).toISOString() });
      cursor = Math.max(cursor, e);
    }
    if (winEnd - cursor >= 15 * 60000) freeSlots.push({ start: new Date(cursor).toISOString(), end: new Date(winEnd).toISOString() });
  }

  const untimed = untimedTasksFor(tasks, events, date, tz).filter((t) => t.status === 'open');
  const estimatedMin = untimed.reduce((s, t) => s + (t.estimateMin ?? 0), 0);
  const freeMin = Math.max(0, windowMin - committedMin);
  return {
    isWorkDay,
    windowMin,
    committedMin,
    freeMin,
    estimatedMin,
    unestimatedCount: untimed.filter((t) => t.estimateMin == null).length,
    balanceMin: freeMin - estimatedMin,
    freeSlots,
  };
}
