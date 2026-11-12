import { describe, expect, it } from 'vitest';
import {
  addDays, dayBounds, diffDays, instantToZoned, minutesBetween, startOfWeek, todayIn, weekdayOf, zonedToInstant,
} from '../shared/dates';
import { isOverdue, nextInstanceDates, nextOccurrence, segmentsForDay, layoutSegments, timeSummary, untimedTasksFor, deadlinesOn, topPriorities } from '../shared/logic';
import { DEFAULT_SETTINGS, type CalEvent, type Task } from '../shared/types';

const OSLO = 'Europe/Oslo';

const task = (o: Partial<Task>): Task => ({
  id: o.id ?? 't1', seriesId: null, title: 'T', notes: '', status: 'open', priority: 0, projectId: null, tags: [],
  estimateMin: null, plannedDate: null, dueDate: null, dueTime: null, focus: false, recurrence: null, remindAt: null,
  reminderStatus: 'none', completedAt: null, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  subtasks: [], ...o,
});
const timed = (id: string, startAt: string, endAt: string, o: Partial<CalEvent> = {}): CalEvent => ({
  id, kind: 'event', taskId: null, title: id, notes: '', location: '', allDay: false, startDate: null, endDate: null,
  startAt, endAt, source: 'app', updatedAt: '', ...o,
});

describe('calendar dates never shift with timezones', () => {
  it('addDays is pure calendar arithmetic across DST changes', () => {
    expect(addDays('2026-03-28', 1)).toBe('2026-03-29'); // EU spring forward
    expect(addDays('2026-03-29', 1)).toBe('2026-03-30');
    expect(addDays('2026-10-24', 1)).toBe('2026-10-25'); // EU fall back
    expect(addDays('2026-10-25', 1)).toBe('2026-10-26');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(diffDays('2026-03-01', '2026-04-01')).toBe(31);
  });

  it('"today" depends on the configured zone, not on UTC or the machine zone', () => {
    const lateEvening = new Date('2026-11-10T23:30:00Z'); // 00:30 on the 11th in Oslo
    expect(todayIn(OSLO, lateEvening)).toBe('2026-11-11');
    expect(todayIn('America/Los_Angeles', lateEvening)).toBe('2026-11-10');
    expect(todayIn('Pacific/Auckland', lateEvening)).toBe('2026-11-11');
  });

  it('a date-only deadline is overdue only after that whole local day', () => {
    const t = task({ dueDate: '2026-11-13' });
    expect(isOverdue(t, new Date('2026-11-13T22:59:00Z'), OSLO)).toBe(false); // 23:59 Oslo on the 13th
    expect(isOverdue(t, new Date('2026-11-13T23:01:00Z'), OSLO)).toBe(true); // 00:01 Oslo on the 14th
    // Same instant, a zone that is still on the 13th: not overdue.
    expect(isOverdue(t, new Date('2026-11-13T23:01:00Z'), 'America/New_York')).toBe(false);
  });

  it('a timed deadline uses the wall-clock time in the configured zone', () => {
    const t = task({ dueDate: '2026-11-13', dueTime: '15:00' });
    expect(isOverdue(t, new Date('2026-11-13T13:59:00Z'), OSLO)).toBe(false);
    expect(isOverdue(t, new Date('2026-11-13T14:01:00Z'), OSLO)).toBe(true);
  });

  it('week start is configurable', () => {
    expect(weekdayOf('2026-11-11')).toBe(3); // Wednesday
    expect(startOfWeek('2026-11-11', 1)).toBe('2026-11-09');
    expect(startOfWeek('2026-11-11', 7)).toBe('2026-11-08');
    expect(startOfWeek('2026-11-09', 1)).toBe('2026-11-09');
  });
});

describe('daylight-saving transitions (Europe/Oslo)', () => {
  it('converts wall time to instants with the right offset on each side', () => {
    expect(zonedToInstant('2026-03-28', '09:00', OSLO)).toBe('2026-03-28T08:00:00.000Z'); // CET
    expect(zonedToInstant('2026-03-29', '09:00', OSLO)).toBe('2026-03-29T07:00:00.000Z'); // CEST
    expect(zonedToInstant('2026-10-25', '09:00', OSLO)).toBe('2026-10-25T08:00:00.000Z'); // CET again
    expect(instantToZoned('2026-03-29T07:00:00.000Z', OSLO)).toEqual({ date: '2026-03-29', time: '09:00' });
  });

  it('spring-forward day is 23 h and fall-back day is 25 h', () => {
    const spring = dayBounds('2026-03-29', OSLO);
    const autumn = dayBounds('2026-10-25', OSLO);
    expect(minutesBetween(spring.start, spring.end)).toBe(23 * 60);
    expect(minutesBetween(autumn.start, autumn.end)).toBe(25 * 60);
  });

  it('a non-existent local time moves forward instead of failing', () => {
    expect(zonedToInstant('2026-03-29', '02:30', OSLO)).toBe('2026-03-29T01:30:00.000Z'); // shown as 03:30
  });

  it('events keep their wall-clock position on DST days', () => {
    const e = timed('a', zonedToInstant('2026-03-29', '10:00', OSLO), zonedToInstant('2026-03-29', '11:30', OSLO));
    const [seg] = segmentsForDay([e], '2026-03-29', OSLO);
    expect([seg.startMin, seg.endMin]).toEqual([600, 690]);
    const f = timed('b', zonedToInstant('2026-10-25', '10:00', OSLO), zonedToInstant('2026-10-25', '11:30', OSLO));
    const [seg2] = segmentsForDay([f], '2026-10-25', OSLO);
    expect([seg2.startMin, seg2.endMin]).toEqual([600, 690]);
  });
});

describe('recurrence', () => {
  it('daily / weekly / monthly / yearly', () => {
    expect(nextOccurrence({ freq: 'daily', interval: 2 }, '2026-11-11')).toBe('2026-11-13');
    expect(nextOccurrence({ freq: 'weekly', interval: 1 }, '2026-11-11')).toBe('2026-11-18');
    expect(nextOccurrence({ freq: 'weekly', interval: 1, weekdays: [1, 3, 5] }, '2026-11-11')).toBe('2026-11-13');
    expect(nextOccurrence({ freq: 'weekly', interval: 2, weekdays: [1, 3] }, '2026-11-11')).toBe('2026-11-23');
    expect(nextOccurrence({ freq: 'yearly', interval: 1, dayOfMonth: 29 }, '2028-02-29')).toBe('2029-02-28');
  });

  it('monthly on the 31st does not drift after short months', () => {
    const rule = { freq: 'monthly' as const, interval: 1, dayOfMonth: 31 };
    expect(nextOccurrence(rule, '2026-01-31')).toBe('2026-02-28');
    expect(nextOccurrence(rule, '2026-02-28')).toBe('2026-03-31');
  });

  it('keeps the planned-day/deadline gap and never creates an instance in the past', () => {
    const rule = { freq: 'weekly' as const, interval: 1 };
    expect(nextInstanceDates(rule, '2026-11-10', '2026-11-13', '2026-11-10')).toEqual({ plannedDate: '2026-11-17', dueDate: '2026-11-20' });
    // Completed three weeks late: the next instance is the first one on/after the completion day.
    expect(nextInstanceDates(rule, '2026-11-10', null, '2026-12-02')).toEqual({ plannedDate: '2026-12-08', dueDate: null });
    expect(nextInstanceDates(rule, null, null, '2026-12-02')).toBeNull();
  });
});

describe('calendar day structure', () => {
  const tasks = [
    task({ id: 'a', plannedDate: '2026-11-10', dueDate: '2026-11-13' }),
    task({ id: 'b', plannedDate: '2026-11-10' }),
    task({ id: 'c', dueDate: '2026-11-10' }),
  ];
  const block = timed('blk', zonedToInstant('2026-11-10', '09:00', OSLO), zonedToInstant('2026-11-10', '10:00', OSLO), { kind: 'task_block', taskId: 'b' });

  it('untimed area holds tasks planned that day that have no time block that day', () => {
    expect(untimedTasksFor(tasks, [], '2026-11-10', OSLO).map((t) => t.id)).toEqual(['a', 'b']);
    expect(untimedTasksFor(tasks, [block], '2026-11-10', OSLO).map((t) => t.id)).toEqual(['a']);
    expect(untimedTasksFor(tasks, [block], '2026-11-13', OSLO)).toEqual([]);
  });

  it('a deadline is shown as a marker on its own day, not as a task planned for that day', () => {
    expect(deadlinesOn(tasks, '2026-11-13').map((t) => t.id)).toEqual(['a']);
    expect(deadlinesOn(tasks, '2026-11-10').map((t) => t.id)).toEqual(['c']);
  });

  it('overlapping timed items are laid out side by side and flagged as conflicts', () => {
    const at = (h1: string, h2: string, id: string) => timed(id, zonedToInstant('2026-11-10', h1, OSLO), zonedToInstant('2026-11-10', h2, OSLO));
    const laid = layoutSegments(segmentsForDay([at('09:00', '10:00', 'x'), at('09:30', '10:30', 'y'), at('11:00', '12:00', 'z')], '2026-11-10', OSLO));
    const by = Object.fromEntries(laid.map((l) => [l.event.id, l]));
    expect(by.x.conflict && by.y.conflict).toBe(true);
    expect(by.x.col).not.toBe(by.y.col);
    expect(by.x.cols).toBe(2);
    expect(by.z.conflict).toBe(false);
    expect(by.z.cols).toBe(1);
  });

  it('an event crossing midnight is split per day', () => {
    const e = timed('n', zonedToInstant('2026-11-10', '22:00', OSLO), zonedToInstant('2026-11-11', '01:00', OSLO));
    const d1 = segmentsForDay([e], '2026-11-10', OSLO)[0];
    const d2 = segmentsForDay([e], '2026-11-11', OSLO)[0];
    expect([d1.startMin, d1.endMin, d1.continuesAfter]).toEqual([1320, 1440, true]);
    expect([d2.startMin, d2.endMin, d2.continuesBefore]).toEqual([0, 60, true]);
  });
});

describe('available time', () => {
  const s = { ...DEFAULT_SETTINGS }; // 08:00-16:00 Mon-Fri, Europe/Oslo
  const day = '2026-11-10'; // Tuesday
  const ev = (a: string, b: string, id = a) => timed(id, zonedToInstant(day, a, OSLO), zonedToInstant(day, b, OSLO));

  it('subtracts the union of commitments from the working window', () => {
    const r = timeSummary(day, [task({ plannedDate: day, estimateMin: 90 }), task({ id: 'u', plannedDate: day })],
      [ev('09:00', '10:00'), ev('09:30', '11:00'), ev('18:00', '19:00')], s, new Date('2026-11-09T12:00:00Z'));
    expect(r.windowMin).toBe(480);
    expect(r.committedMin).toBe(120); // 09:00-11:00 merged; evening event is outside working hours
    expect(r.freeMin).toBe(360);
    expect(r.estimatedMin).toBe(90);
    expect(r.unestimatedCount).toBe(1);
    expect(r.balanceMin).toBe(270);
    expect(r.freeSlots).toHaveLength(2);
  });

  it('for today only the remaining part of the working day counts', () => {
    const r = timeSummary(day, [], [ev('09:00', '10:00'), ev('14:00', '15:00')], s, new Date(zonedToInstant(day, '13:00', OSLO)));
    expect(r.windowMin).toBe(180);
    expect(r.committedMin).toBe(60);
    expect(r.freeMin).toBe(120);
  });

  it('non-working days report no working time rather than a guess', () => {
    const r = timeSummary('2026-11-14', [], [], s, new Date('2026-11-09T12:00:00Z'));
    expect(r.isWorkDay).toBe(false);
    expect(r.freeMin).toBe(0);
  });
});

describe('top priorities', () => {
  it('starred tasks come first; the rest are marked as suggestions', () => {
    const now = new Date('2026-11-10T09:00:00Z');
    const list = topPriorities([
      task({ id: 'star', focus: true }),
      task({ id: 'late', dueDate: '2026-11-01' }),
      task({ id: 'today', plannedDate: '2026-11-10', priority: 3 }),
      task({ id: 'someday' }),
    ], now, OSLO);
    expect(list.map((p) => [p.task.id, p.suggested])).toEqual([['star', false], ['late', true], ['today', true]]);
  });
});
