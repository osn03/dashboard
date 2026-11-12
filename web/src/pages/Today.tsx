import { Link } from 'react-router';
import { formatDate, formatDuration, formatTime } from '../../../shared/dates';
import { allDayEventsFor, bucketTasks, layoutSegments, segmentsForDay, timeSummary, topPriorities, untimedTasksFor } from '../../../shared/logic';
import { useEvents, useNotes, useTasks, useActions, useTraining } from '../api';
import { TrainingRow, TrainingSource } from '../components/Training';
import { QuickCapture } from '../components/QuickCapture';
import { CheckButton, TaskList, TaskRow } from '../components/TaskRow';
import { useEnv } from '../env';
import { pill } from '../color';
import { useUI } from '../ui';

function TrainingCard() {
  const q = useTraining();
  const t = q.data;
  return (
    <section className="card" aria-label="Today's training">
      <h2>Training <Link className="more" to="/training">Open training</Link></h2>
      {q.isLoading ? (
        <p className="empty">Loading…</p>
      ) : !t ? (
        <p className="banner error" role="alert">Could not load training data.</p>
      ) : t.status.state === 'not_configured' ? (
        <p className="empty">Intervals.icu is not connected. <Link to="/training">Set it up</Link> to see planned and completed training here.</p>
      ) : (
        <>
          {t.todayPlanned.length + t.todayCompleted.length === 0 ? (
            <p className="empty">No workout planned and no activity recorded today.</p>
          ) : (
            <ul className="tr-list">
              {t.todayPlanned.map((i) => <TrainingRow key={`p${i.id}`} item={i} />)}
              {t.todayCompleted.map((i) => <TrainingRow key={`a${i.id}`} item={i} />)}
            </ul>
          )}
          {t.upcoming[0] && <p className="muted small">Next: {t.upcoming[0].name} on {formatDate(t.upcoming[0].date)}</p>}
          <TrainingSource status={t.status} />
        </>
      )}
    </section>
  );
}

export function TodayPage() {
  const { today, tz, now, settings } = useEnv();
  const tasksQ = useTasks();
  const eventsQ = useEvents(today, today);
  const notesQ = useNotes();
  const actions = useActions();
  const { openEvent, openTask } = useUI();

  if (tasksQ.isLoading || eventsQ.isLoading) return <div className="page"><p className="empty">Loading today…</p></div>;
  if (tasksQ.isError || eventsQ.isError) {
    return (
      <div className="page">
        <p className="banner error" role="alert">
          Could not load your data. Your tasks are safe in the local database — check that the server is running, then{' '}
          <button className="link" onClick={() => { void tasksQ.refetch(); void eventsQ.refetch(); }}>try again</button>.
        </p>
      </div>
    );
  }

  const tasks = tasksQ.data ?? [];
  const events = eventsQ.data ?? [];
  const b = bucketTasks(tasks, now, tz);
  const top = topPriorities(tasks, now, tz);
  const allDay = allDayEventsFor(events, today);
  const timed = layoutSegments(segmentsForDay(events, today, tz));
  const untimed = untimedTasksFor(tasks, events, today, tz);
  const dueTodayElsewhere = b.today.filter((t) => t.plannedDate !== today);
  const sum = timeSummary(today, tasks, events, settings, now);
  const nowIso = now.toISOString();

  return (
    <div className="page today-page">
      <header className="page-head">
        <div>
          <h1>Today</h1>
          <p className="muted">{formatDate(today, 'long')}</p>
        </div>
      </header>

      <QuickCapture />

      <section className="card time-card" aria-label="Available time">
        <h2>Time available</h2>
        {!sum.isWorkDay ? (
          <p>Not a working day in your settings, so no working time is counted. {timed.length > 0 && `${timed.length} timed item${timed.length > 1 ? 's' : ''} on the schedule.`}</p>
        ) : sum.windowMin === 0 ? (
          <p>Working hours ({settings.workStart}–{settings.workEnd}) are over for today.</p>
        ) : (
          <>
            <p className="time-headline">
              <strong>{formatDuration(sum.freeMin)}</strong> free before {settings.workEnd}
              <span className="muted"> · {formatDuration(sum.committedMin)} already scheduled of {formatDuration(sum.windowMin)} left in working hours</span>
            </p>
            <p className={sum.balanceMin < 0 ? 'warn-text' : 'muted'}>
              {sum.estimatedMin > 0
                ? sum.balanceMin < 0
                  ? `Untimed tasks are estimated at ${formatDuration(sum.estimatedMin)} — about ${formatDuration(-sum.balanceMin)} more than fits. Consider moving something.`
                  : `Untimed tasks are estimated at ${formatDuration(sum.estimatedMin)}, which fits.`
                : 'No estimates on today’s untimed tasks.'}
              {sum.unestimatedCount > 0 && ` ${sum.unestimatedCount} task${sum.unestimatedCount > 1 ? 's have' : ' has'} no estimate and ${sum.unestimatedCount > 1 ? 'are' : 'is'} not counted.`}
            </p>
            {sum.freeSlots.length > 0 && (
              <p className="muted">
                Free: {sum.freeSlots.map((s) => `${formatTime(s.start, tz, settings.hour12)}–${formatTime(s.end, tz, settings.hour12)}`).join(', ')}
              </p>
            )}
          </>
        )}
      </section>

      <div className="today-grid">
        <div className="col">
          <section className="card" aria-label="Top three priorities">
            <h2>Top three</h2>
            {top.length === 0 ? (
              <p className="empty">Star a task (☆) to make it a priority.</p>
            ) : (
              <ul className="task-list">
                {top.map((p) => (
                  <TaskRow key={p.task.id} task={p.task} suggested={p.suggested} />
                ))}
              </ul>
            )}
          </section>

          <section className="card" aria-label="Tasks today without a set time">
            <h2>Tasks today <span className="count">{untimed.filter((t) => t.status === 'open').length}</span></h2>
            <TaskList tasks={untimed} hidePlanned empty="No untimed tasks planned for today." />
            {dueTodayElsewhere.length > 0 && (
              <>
                <h3>Due today, not planned for today</h3>
                <TaskList tasks={dueTodayElsewhere} empty="" />
              </>
            )}
          </section>

          {(b.overdue.length > 0 || b.missed.length > 0) && (
            <section className="card attention" aria-label="Overdue and missed tasks">
              <h2>Needs attention <span className="count">{b.overdue.length + b.missed.length}</span></h2>
              {b.overdue.length > 0 && (
                <>
                  <h3>Overdue</h3>
                  <TaskList tasks={b.overdue} empty="" />
                </>
              )}
              {b.missed.length > 0 && (
                <>
                  <h3>Missed (planned earlier, still open)</h3>
                  <TaskList tasks={b.missed} empty="" />
                </>
              )}
            </section>
          )}
        </div>

        <div className="col">
          <section className="card" aria-label="Today's timed schedule">
            <h2>Schedule <Link className="more" to={`/calendar?view=day&date=${today}`}>Open day view</Link></h2>
            {allDay.length > 0 && (
              <div className="allday-strip">
                <span className="label">All-day</span>
                {allDay.map((e) => (
                  <button key={e.id} className="allday-pill" style={pill(e.google?.color)} onClick={() => openEvent(e)}>{e.title}</button>
                ))}
              </div>
            )}
            {timed.length === 0 ? (
              <p className="empty">Nothing on the timed schedule today.</p>
            ) : (
              <ul className="sched-list">
                {timed.map((s) => {
                  const task = tasks.find((t) => t.id === s.event.taskId);
                  const past = s.event.endAt! <= nowIso;
                  const current = s.event.startAt! <= nowIso && !past;
                  return (
                    <li key={s.event.id} className={past ? 'past' : ''}>
                      <div className={`sched-item ${s.event.kind === 'task_block' ? 'is-block' : s.event.kind === 'training' ? 'is-training' : 'is-event'}`} style={s.event.google?.color ? { borderLeftColor: s.event.google.color } : undefined}>
                        <span className="sched-time">{formatTime(s.event.startAt!, tz, settings.hour12)}–{formatTime(s.event.endAt!, tz, settings.hour12)}</span>
                        {task && <CheckButton task={task} small />}
                        <button className={`link plain sched-title${task?.status === 'done' ? ' struck' : ''}`} onClick={() => openEvent(s.event)}>{s.event.title}</button>
                        {s.event.location && <span className="muted">{s.event.location}</span>}
                        {s.event.google && <span className="badge subtle">Google · {s.event.google.calendarName}</span>}
                        {s.event.kind === 'training' && <span className="badge subtle">{s.event.training?.what === 'completed' ? 'Completed' : 'Planned'} training</span>}
                        {current && <span className="badge">Now</span>}
                        {s.conflict && <span className="badge danger">Overlap</span>}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <TrainingCard />

          <section className="card" aria-label="Upcoming deadlines">
            <h2>Upcoming deadlines <span className="muted small">next 14 days</span></h2>
            {b.dueSoon.length === 0 ? (
              <p className="empty">No deadlines in the next two weeks.</p>
            ) : (
              <ul className="deadline-list">
                {b.dueSoon.map((t) => (
                  <li key={t.id}>
                    <span className="deadline-date">{formatDate(t.dueDate!)}{t.dueTime ? ` ${t.dueTime}` : ''}</span>
                    <button className="link plain" onClick={() => openTask(t.id)}>{t.title}</button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {(notesQ.data?.length ?? 0) > 0 && (
            <section className="card" aria-label="Notes">
              <h2>Notes</h2>
              <ul className="note-list">
                {notesQ.data!.filter((n) => !n.taskId && !n.projectId).slice(0, 8).map((n) => (
                  <li key={n.id}>
                    <span>{n.body}</span>
                    <button className="icon-btn" aria-label="Delete note" onClick={() => void actions.deleteNote(n.id)}>×</button>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
