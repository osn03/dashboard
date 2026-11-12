// API tests run in-process against a real SQLite database (no mocks).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { todayIn, addDays, zonedToInstant } from '../shared/dates';
import { makeClient, type TestClient } from './helpers';

const OSLO = 'Europe/Oslo';
let c: TestClient;
beforeEach(async () => {
  c = await makeClient();
});

describe('auth and request validation', () => {
  it('rejects unauthenticated access and requests without the CSRF header', async () => {
    expect((await c.req('GET', '/api/tasks', undefined, { noAuth: true })).status).toBe(401);
    expect((await c.req('POST', '/api/tasks', { title: 'x' }, { headers: { 'x-requested-with': '' } })).status).toBe(403);
    expect((await c.req('POST', '/api/tasks', { title: 'x' }, { headers: { origin: 'https://evil.example', host: '127.0.0.1:8787' } })).status).toBe(403);
  });

  it('allows setup only once and rejects wrong passwords', async () => {
    expect((await c.req('POST', '/api/auth/setup', { username: 'x', password: 'another password' })).status).toBe(409);
    expect((await c.req('POST', '/api/auth/login', { username: 'me', password: 'wrong password!' })).status).toBe(401);
    const stored = c.db.prepare('SELECT password_hash FROM users').get() as any;
    expect(stored.password_hash).toMatch(/^scrypt\$/);
    expect(stored.password_hash).not.toContain('correct horse');
  });

  it('validates input at the mutation boundary', async () => {
    expect((await c.req('POST', '/api/tasks', { title: '' })).status).toBe(400);
    expect((await c.req('POST', '/api/tasks', { title: 'x', dueDate: '2026-02-30' })).status).toBe(400);
    expect((await c.req('POST', '/api/tasks', { title: 'x', dueDate: '2026-11-13T00:00:00Z' })).status).toBe(400);
    expect((await c.req('POST', '/api/tasks', { title: 'x', dueTime: '10:00' })).status).toBe(400);
    expect((await c.req('POST', '/api/tasks', { title: 'x', unknownField: 1 })).status).toBe(400);
    expect((await c.req('PUT', '/api/settings', { timezone: 'Mars/Olympus' })).status).toBe(400);
  });
});

describe('planned day vs deadline (acceptance 1 and 2)', () => {
  it('moving the planned day never changes the deadline', async () => {
    const t = (await c.req('POST', '/api/tasks', { title: 'Report', plannedDate: '2026-11-10', dueDate: '2026-11-13' })).json;
    const moved = (await c.req('PATCH', `/api/tasks/${t.id}`, { plannedDate: '2026-11-11' })).json;
    expect(moved.plannedDate).toBe('2026-11-11');
    expect(moved.dueDate).toBe('2026-11-13');
    const cleared = (await c.req('PATCH', `/api/tasks/${t.id}`, { plannedDate: null })).json;
    expect(cleared.dueDate).toBe('2026-11-13');
    const hist = (await c.req('GET', `/api/tasks/${t.id}/history`)).json;
    expect(hist.filter((h: any) => h.type === 'rescheduled')).toHaveLength(2);
    expect(hist.some((h: any) => h.type === 'deadline_changed')).toBe(false);
  });

  it('date-only values are stored and returned as the same calendar date in any timezone', async () => {
    const t = (await c.req('POST', '/api/tasks', { title: 'Passport', dueDate: '2026-11-13', plannedDate: '2026-11-12' })).json;
    for (const timezone of ['Pacific/Kiritimati', 'Pacific/Pago_Pago', 'Europe/Oslo']) {
      await c.req('PUT', '/api/settings', { timezone });
      const again = (await c.req('GET', `/api/tasks/${t.id}`)).json;
      expect([again.dueDate, again.plannedDate, again.dueTime]).toEqual(['2026-11-13', '2026-11-12', null]);
    }
    const raw = c.db.prepare('SELECT due_date, planned_date FROM tasks WHERE id = ?').get(t.id) as any;
    expect(raw).toEqual({ due_date: '2026-11-13', planned_date: '2026-11-12' });
  });
});

describe('tasks and time blocks (acceptance 3)', () => {
  it('scheduling creates one linked block, no duplicate task, and keeps the deadline', async () => {
    const t = (await c.req('POST', '/api/tasks', { title: 'Write', plannedDate: '2026-11-10', dueDate: '2026-11-13' })).json;
    const startAt = zonedToInstant('2026-11-10', '09:00', OSLO);
    const endAt = zonedToInstant('2026-11-10', '10:00', OSLO);
    const block = (await c.req('POST', `/api/tasks/${t.id}/schedule`, { startAt, endAt })).json;
    expect(block).toMatchObject({ kind: 'task_block', taskId: t.id, title: 'Write', startAt, endAt });

    const tasks = (await c.req('GET', '/api/tasks')).json;
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ plannedDate: '2026-11-10', dueDate: '2026-11-13' });
    const events = (await c.req('GET', '/api/events?from=2026-11-10&to=2026-11-10')).json;
    expect(events).toHaveLength(1);
  });

  it('moving a block to another day moves the planned day but not the deadline', async () => {
    const t = (await c.req('POST', '/api/tasks', { title: 'Write', plannedDate: '2026-11-10', dueDate: '2026-11-13' })).json;
    const block = (await c.req('POST', `/api/tasks/${t.id}/schedule`, {
      startAt: zonedToInstant('2026-11-10', '09:00', OSLO), endAt: zonedToInstant('2026-11-10', '10:00', OSLO),
    })).json;
    await c.req('PATCH', `/api/events/${block.id}`, {
      startAt: zonedToInstant('2026-11-12', '14:00', OSLO), endAt: zonedToInstant('2026-11-12', '15:30', OSLO),
    });
    const after = (await c.req('GET', `/api/tasks/${t.id}`)).json;
    expect(after).toMatchObject({ plannedDate: '2026-11-12', dueDate: '2026-11-13' });
  });

  it('completing a task keeps its block; removing the block keeps the task', async () => {
    const t = (await c.req('POST', '/api/tasks', { title: 'Call', plannedDate: '2026-11-10' })).json;
    const block = (await c.req('POST', `/api/tasks/${t.id}/schedule`, {
      startAt: zonedToInstant('2026-11-10', '09:00', OSLO), endAt: zonedToInstant('2026-11-10', '09:30', OSLO),
    })).json;
    await c.req('POST', `/api/tasks/${t.id}/complete`);
    expect((await c.req('GET', '/api/events?from=2026-11-10&to=2026-11-10')).json).toHaveLength(1);
    await c.req('POST', `/api/tasks/${t.id}/reopen`);
    expect((await c.req('DELETE', `/api/events/${block.id}`)).status).toBe(200);
    const still = (await c.req('GET', `/api/tasks/${t.id}`)).json;
    expect(still).toMatchObject({ status: 'open', plannedDate: '2026-11-10' });
  });

  it('rejects blocks that end before they start and all-day/timed mix-ups', async () => {
    const t = (await c.req('POST', '/api/tasks', { title: 'x' })).json;
    expect((await c.req('POST', `/api/tasks/${t.id}/schedule`, { startAt: '2026-11-10T10:00:00Z', endAt: '2026-11-10T09:00:00Z' })).status).toBe(400);
    const allDay = (await c.req('POST', '/api/events', { title: 'Holiday', allDay: true, startDate: '2026-11-10', endDate: '2026-11-11' })).json;
    expect(allDay).toMatchObject({ allDay: true, startDate: '2026-11-10', endDate: '2026-11-11', startAt: null });
    expect((await c.req('PATCH', `/api/events/${allDay.id}`, { startAt: '2026-11-10T10:00:00Z' })).status).toBe(400);
  });
});

describe('recurring tasks and missed tasks', () => {
  it('completing a recurring task preserves the finished instance and creates the next one', async () => {
    const today = todayIn(OSLO);
    const t = (await c.req('POST', '/api/tasks', {
      title: 'Water plants', plannedDate: today, dueDate: addDays(today, 1), recurrence: { freq: 'weekly', interval: 1 }, subtasks: ['Kitchen'],
    })).json;
    await c.req('PATCH', `/api/subtasks/${t.subtasks[0].id}`, { done: true });
    const r = (await c.req('POST', `/api/tasks/${t.id}/complete`)).json;
    expect(r.task.status).toBe('done');
    expect(r.task.completedAt).toBeTruthy();
    expect(r.next).toMatchObject({ status: 'open', plannedDate: addDays(today, 7), dueDate: addDays(today, 8), seriesId: t.id });
    expect(r.next.subtasks[0].done).toBe(false);

    // Completing again (e.g. a retried request) must not spawn a second instance.
    await c.req('POST', `/api/tasks/${t.id}/complete`);
    await c.req('POST', `/api/tasks/${t.id}/reopen`);
    await c.req('POST', `/api/tasks/${t.id}/complete`);
    const all = (await c.req('GET', '/api/tasks?done=all')).json;
    expect(all).toHaveLength(2);
    const hist = (await c.req('GET', `/api/tasks/${r.next.id}/history`)).json;
    expect(hist.filter((h: any) => h.type === 'completed').length).toBe(2);
  });

  it('missed tasks stay open until completed, rescheduled or dismissed', async () => {
    const t = (await c.req('POST', '/api/tasks', { title: 'Old', plannedDate: '2020-01-01' })).json;
    expect((await c.req('GET', '/api/tasks')).json[0].status).toBe('open');
    const d = (await c.req('POST', `/api/tasks/${t.id}/dismiss`)).json;
    expect(d.task.status).toBe('dismissed');
  });

  it('a recurring task needs a date to recur from', async () => {
    expect((await c.req('POST', '/api/tasks', { title: 'x', recurrence: { freq: 'daily', interval: 1 } })).status).toBe(400);
  });
});

describe('persistence (acceptance 14)', () => {
  it('tasks, blocks and settings survive closing and reopening the database', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dash-'));
    const path = join(dir, 'test.db');
    try {
      const a = await makeClient(path);
      const t = (await a.req('POST', '/api/tasks', { title: 'Persist me', plannedDate: '2026-11-10', dueDate: '2026-11-13', tags: ['x'] })).json;
      await a.req('POST', `/api/tasks/${t.id}/schedule`, { startAt: '2026-11-10T08:00:00Z', endAt: '2026-11-10T09:00:00Z' });
      await a.req('PUT', '/api/settings', { workStart: '09:00' });
      a.db.close();

      const b = await makeClient(path);
      const tasks = (await b.req('GET', '/api/tasks')).json;
      expect(tasks).toHaveLength(1);
      expect(tasks[0]).toMatchObject({ title: 'Persist me', plannedDate: '2026-11-10', dueDate: '2026-11-13', tags: ['x'] });
      expect((await b.req('GET', '/api/events?from=2026-11-10&to=2026-11-10')).json).toHaveLength(1);
      expect((await b.req('GET', '/api/settings')).json.workStart).toBe('09:00');
      const exported = (await b.req('GET', '/api/export')).json;
      expect(exported.tasks).toHaveLength(1);
      expect(JSON.stringify(exported)).not.toContain('password_hash');
      b.db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
