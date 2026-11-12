import { useState } from 'react';
import { addDays, dayBounds, formatDate, startOfWeek } from '../../../shared/dates';
import { compareTasks, isOverdue } from '../../../shared/logic';
import { useEvents, useTasks, useTraining } from '../api';
import { TaskList } from '../components/TaskRow';
import { TotalsTable, TrainingSource } from '../components/Training';
import { useEnv } from '../env';

/** Weekly review: what got done, what is still open, what is due next, and training. */
export function ReviewPage() {
  const { today, tz, now, settings } = useEnv();
  const [anchor, setAnchor] = useState(today);
  const start = startOfWeek(anchor, settings.weekStart);
  const end = addDays(start, 6);
  const tasksQ = useTasks();
  const eventsQ = useEvents(start, end);
  const training = useTraining(start);
  const tasks = tasksQ.data ?? [];
  const from = dayBounds(start, tz).start;
  const to = dayBounds(end, tz).end;
  const isCurrent = today >= start && today <= end;

  const completed = tasks
    .filter((t) => t.status === 'done' && t.completedAt && t.completedAt >= from && t.completedAt < to)
    .sort((a, b) => (a.completedAt! < b.completedAt! ? -1 : 1));
  const open = tasks.filter((t) => t.status === 'open');
  const unfinished = open.filter((t) => t.plannedDate && t.plannedDate >= start && t.plannedDate <= end && t.plannedDate < today).sort(compareTasks);
  const olderOpen = open.filter((t) => t.plannedDate && t.plannedDate < start).sort(compareTasks);
  const overdue = open.filter((t) => isOverdue(t, now, tz)).sort(compareTasks);
  const nextStart = addDays(end, 1);
  const nextEnd = addDays(end, 7);
  const dueNext = open.filter((t) => t.dueDate && t.dueDate >= (isCurrent ? today : nextStart) && t.dueDate <= nextEnd && !overdue.includes(t)).sort((a, b) => (a.dueDate! < b.dueDate! ? -1 : 1));
  const inbox = open.filter((t) => !t.plannedDate && !t.projectId);
  const events = (eventsQ.data ?? []).filter((e) => e.kind === 'event');
  const estDone = completed.reduce((s, t) => s + (t.estimateMin ?? 0), 0);
  const tr = training.data;

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Weekly review</h1>
          <p className="muted">{formatDate(start, 'long')} – {formatDate(end, 'long')}</p>
        </div>
        <span className="spacer" />
        <div className="btn-group">
          <button className="btn" aria-label="Previous week" onClick={() => setAnchor(addDays(start, -7))}>‹</button>
          <button className="btn" onClick={() => setAnchor(today)}>This week</button>
          <button className="btn" aria-label="Next week" onClick={() => setAnchor(addDays(start, 7))}>›</button>
        </div>
      </header>

      {tasksQ.isLoading && <p className="empty">Loading…</p>}
      {tasksQ.isError && <p className="banner error" role="alert">Could not load tasks. Check that the server is running, then reload.</p>}

      <section className="card stat-row" aria-label="Week in numbers">
        <div><strong>{completed.length}</strong><span>tasks completed</span></div>
        <div><strong>{unfinished.length + olderOpen.length}</strong><span>planned but not done</span></div>
        <div><strong>{overdue.length}</strong><span>past their deadline</span></div>
        <div><strong>{events.length}</strong><span>calendar events</span></div>
        <div><strong>{inbox.length}</strong><span>in the Inbox</span></div>
      </section>

      <div className="today-grid">
        <div className="col">
          <section className="card" aria-label="Completed this week">
            <h2>Completed <span className="count">{completed.length}</span></h2>
            <TaskList tasks={completed} empty="Nothing was completed in this week." />
            {estDone > 0 && <p className="hint">Estimated work completed: {Math.round(estDone / 6) / 10} h (only tasks that had an estimate).</p>}
          </section>

          <section className="card" aria-label="Training this week">
            <h2>Training</h2>
            {!tr ? (
              <p className="empty">Loading…</p>
            ) : tr.status.state === 'not_configured' ? (
              <p className="empty">Intervals.icu is not connected, so there is no training data for this review.</p>
            ) : (
              <>
                <TotalsTable planned={tr.week.plannedTotals} completed={tr.week.completedTotals} plannedDone={tr.week.plannedDone} />
                <TrainingSource status={tr.status} />
              </>
            )}
          </section>
        </div>

        <div className="col">
          <section className={`card${unfinished.length + olderOpen.length + overdue.length ? ' attention' : ''}`} aria-label="Unfinished tasks">
            <h2>Unfinished</h2>
            <h3>Planned this week, still open</h3>
            <TaskList tasks={unfinished} empty="Everything planned so far this week is done." />
            {olderOpen.length > 0 && (
              <>
                <h3>Carried over from earlier weeks</h3>
                <TaskList tasks={olderOpen} empty="" />
              </>
            )}
            {overdue.length > 0 && (
              <>
                <h3>Past their deadline</h3>
                <TaskList tasks={overdue} empty="" />
              </>
            )}
            <p className="hint">Use “Today” / “Tomorrow” to re-plan, or open a task to pick another day. Deadlines stay as they are.</p>
          </section>

          <section className="card" aria-label="Deadlines ahead">
            <h2>Deadlines until {formatDate(nextEnd)}</h2>
            <TaskList tasks={dueNext} empty="No deadlines in that period." />
          </section>

          {inbox.length > 0 && (
            <section className="card" aria-label="Inbox to sort">
              <h2>Inbox to sort <span className="count">{inbox.length}</span></h2>
              <TaskList tasks={inbox.slice(0, 10)} empty="" />
              {inbox.length > 10 && <p className="hint">…and {inbox.length - 10} more in Tasks → Inbox.</p>}
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
