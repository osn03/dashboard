import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import {
  addDays, addMinutes, dateRange, dayBounds, formatDate, formatTime, formatWallTime, isValidDate, minutesBetween,
  minutesToTime, startOfMonth, startOfWeek, timeToMinutes, weekdayOf, zonedToInstant, instantToZoned,
} from '../../../shared/dates';
import { allDayEventsFor, deadlinesOn, layoutSegments, segmentsForDay, untimedTasksFor, untimedTrainingFor, type LaidOut } from '../../../shared/logic';
import type { CalEvent, Task } from '../../../shared/types';
import { useActions, useEvents, useGoogle, useTasks } from '../api';
import { CheckButton } from '../components/TaskRow';
import { useEnv } from '../env';
import { pill } from '../color';
import { useUI } from '../ui';

type View = 'day' | 'week' | 'month' | 'agenda';
const VIEWS: View[] = ['day', 'week', 'month', 'agenda'];
const HOUR = 44; // px per hour
const SNAP = 15;

// HTML5 drag-and-drop cannot read payloads during dragover, so the dragged item is kept here.
type DragState =
  | { type: 'task'; id: string; durationMin: number }
  | { type: 'event'; event: CalEvent; durationMin: number; grabMin: number };
let drag: DragState | null = null;

export function CalendarPage() {
  const { today, settings } = useEnv();
  const [params, setParams] = useSearchParams();
  const narrow = typeof window !== 'undefined' && window.innerWidth < 720;
  const view = (VIEWS.includes(params.get('view') as View) ? params.get('view') : narrow ? 'day' : 'week') as View;
  const date = isValidDate(params.get('date') ?? '') ? params.get('date')! : today;
  const go = (next: Partial<{ view: View; date: string }>) =>
    setParams({ view: next.view ?? view, date: next.date ?? date }, { replace: true });
  const { newEvent } = useUI();

  const days = useMemo(() => {
    if (view === 'day') return [date];
    if (view === 'week') return dateRange(startOfWeek(date, settings.weekStart), 7);
    if (view === 'agenda') return dateRange(date, 14);
    return dateRange(startOfWeek(startOfMonth(date), settings.weekStart), 42);
  }, [view, date, settings.weekStart]);

  const tasks = useTasks();
  const events = useEvents(days[0], days[days.length - 1]);
  const step = view === 'day' ? 1 : view === 'week' ? 7 : view === 'agenda' ? 14 : 0;
  const shift = (dir: 1 | -1) => {
    if (view === 'month') {
      const first = startOfMonth(date);
      go({ date: dir === 1 ? startOfMonth(addDays(first, 32)) : startOfMonth(addDays(first, -1)) });
    } else go({ date: addDays(date, dir * step) });
  };
  const title =
    view === 'day' ? formatDate(date, 'long')
    : view === 'month' ? formatDate(date, 'month')
    : `${formatDate(days[0])} – ${formatDate(days[view === 'week' ? 6 : 13])} ${days[0].slice(0, 4)}`;

  return (
    <div className="page calendar-page">
      <header className="cal-toolbar">
        <div className="btn-group">
          <button className="btn" onClick={() => shift(-1)} aria-label="Previous">‹</button>
          <button className="btn" onClick={() => go({ date: today })}>Today</button>
          <button className="btn" onClick={() => shift(1)} aria-label="Next">›</button>
        </div>
        <h1 className="cal-title">{title}</h1>
        <span className="spacer" />
        <div className="segmented" role="radiogroup" aria-label="Calendar view">
          {VIEWS.map((v) => (
            <label key={v} className={view === v ? 'on' : ''}>
              <input type="radio" name="cal-view" checked={view === v} onChange={() => go({ view: v })} />
              {v[0].toUpperCase() + v.slice(1)}
            </label>
          ))}
        </div>
        <GoogleSyncBadge />
        <button className="btn primary" onClick={() => newEvent({ date: view === 'day' ? date : today })}>New event</button>
      </header>

      {(tasks.isError || events.isError) && (
        <p className="banner error" role="alert">Could not load the calendar. Check that the server is running, then reload.</p>
      )}
      {tasks.isLoading || events.isLoading ? (
        <p className="empty">Loading calendar…</p>
      ) : view === 'month' ? (
        <MonthView days={days} month={date.slice(0, 7)} tasks={tasks.data ?? []} events={events.data ?? []} onDay={(d) => go({ view: 'day', date: d })} />
      ) : view === 'agenda' ? (
        <AgendaView days={days} tasks={tasks.data ?? []} events={events.data ?? []} onDay={(d) => go({ view: 'day', date: d })} />
      ) : (
        <TimeGrid days={days} tasks={tasks.data ?? []} events={events.data ?? []} onDay={(d) => go({ view: 'day', date: d })} />
      )}
    </div>
  );
}

/** Source + freshness of Google data, with manual refresh. Hidden when Google is not connected. */
function GoogleSyncBadge() {
  const google = useGoogle();
  const actions = useActions();
  const { tz, settings } = useEnv();
  const [busy, setBusy] = useState(false);
  const st = google.data;
  if (!st || st.state !== 'connected' || !st.canConnect) return null;
  const liveIds = new Set(st.accounts.filter((x) => x.status === 'connected').map((x) => x.id));
  const lost = st.accounts.filter((x) => x.status === 'revoked');
  const shown = st.calendars.filter((c) => c.selected && liveIds.has(c.accountId));
  const failed = shown.filter((c) => c.lastError);
  const accountError = st.accounts.find((x) => x.status === 'connected' && x.lastError)?.lastError;
  const oldest = shown.map((c) => c.lastSyncedAt).filter((x): x is string => !!x).sort()[0];
  return (
    <span className="sync-badge">
      {lost.length > 0 && <Link className="badge danger" to="/settings">Google access lost for {lost.length > 1 ? `${lost.length} accounts` : (lost[0].label ?? 'an account')} – reconnect</Link>}
      {failed.length > 0 || accountError ? (
        <Link className="badge danger" to="/settings" title={accountError ?? failed[0]?.lastError ?? ''}>
          Google sync failed{oldest ? ` · showing data from ${formatTime(oldest, tz, settings.hour12)}` : ''}
        </Link>
      ) : shown.length > 0 ? (
        <span className="badge subtle" title="Oldest successful sync among the calendars shown">
          Google · {oldest ? `synced ${formatTime(oldest, tz, settings.hour12)}` : 'not synced yet'}
        </span>
      ) : null}
      <button
        className="icon-btn"
        aria-label="Sync Google Calendar now"
        title="Sync Google Calendar now"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void actions.googleSync().finally(() => setBusy(false));
        }}
      >
        {busy ? '…' : '⟳'}
      </button>
    </span>
  );
}

// ---------------------------------------------------------------- Day / week

function TimeGrid({ days, tasks, events, onDay }: { days: string[]; tasks: Task[]; events: CalEvent[]; onDay: (d: string) => void }) {
  const { today, tz, settings, now } = useEnv();
  const { openTask, openEvent } = useUI();
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    scroller.current?.scrollTo({ top: settings.dayStartHour * HOUR });
  }, [settings.dayStartHour, days.length]);

  const cols = { gridTemplateColumns: `64px repeat(${days.length}, minmax(0, 1fr))` };
  const minWidth = days.length > 1 ? 64 + days.length * 112 : undefined;
  const fmtHour = (h: number) => formatWallTime(`${String(h).padStart(2, '0')}:00`, settings.hour12);

  return (
    <div className="tg-outer">
      <div className="tg" style={{ minWidth }}>
        <div className="tg-top">
          <div className="tg-row tg-head" style={cols}>
            <div className="tg-gutter" />
            {days.map((d) => (
              <div key={d} className={`tg-dayhead${d === today ? ' today' : ''}`}>
                <button className="dayname" onClick={() => onDay(d)} aria-label={`Open ${formatDate(d, 'long')}`}>
                  {formatDate(d, 'weekday')}
                </button>
                {deadlinesOn(tasks, d).map((t) => (
                  <button key={t.id} className="deadline-flag" onClick={() => openTask(t.id)} title={`Deadline: ${t.title}`}>
                    <span aria-hidden>⚑</span> Due{t.dueTime ? ` ${formatWallTime(t.dueTime, settings.hour12)}` : ''}: {t.title}
                  </button>
                ))}
              </div>
            ))}
          </div>

          <div className="tg-row tg-allday" style={cols} aria-label="All-day events">
            <div className="tg-gutter label">All-day</div>
            {days.map((d) => (
              <div key={d} className="tg-cell" data-testid={`allday-${d}`}>
                {allDayEventsFor(events, d).map((e) => (
                  <button key={e.id} className="allday-pill" style={pill(e.google?.color)}
                    onClick={() => openEvent(e)} title={`All-day event: ${e.title}${e.google ? ` (Google · ${e.google.calendarName})` : ''}`}>
                    {e.title}
                  </button>
                ))}
              </div>
            ))}
          </div>

          <div className="tg-row tg-tasks" style={cols} aria-label="Tasks for the day (no set time)">
            <div className="tg-gutter label">Tasks</div>
            {days.map((d) => (
              <DayTasks key={d} date={d} tasks={untimedTasksFor(tasks, events, d, tz)} />
            ))}
          </div>

          {days.some((d) => untimedTrainingFor(events, d).length > 0) && (
            <div className="tg-row tg-training" style={cols} aria-label="Training without a set time">
              <div className="tg-gutter label">Training</div>
              {days.map((d) => (
                <div key={d} className="tg-cell" data-testid={`training-${d}`}>
                  {untimedTrainingFor(events, d).map((e) => (
                    <button key={e.id} className={`training-pill${e.training?.what === 'completed' ? ' completed' : ''}`} onClick={() => openEvent(e)}
                      title={`${e.training?.what === 'completed' ? 'Completed activity' : 'Planned workout (no set time)'}: ${e.title}`}>
                      <span aria-hidden>{e.training?.what === 'completed' ? '✓' : '○'}</span> {e.title}
                      {e.training?.durationMin != null && <span className="muted"> · {e.training.durationMin} min</span>}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="tg-scroll" ref={scroller} aria-label="Timed schedule">
          <div className="tg-row tg-grid" style={{ ...cols, height: 24 * HOUR }}>
            <div className="tg-gutter hours" aria-hidden>
              {Array.from({ length: 23 }, (_, i) => (
                <span key={i} style={{ top: (i + 1) * HOUR }}>{fmtHour(i + 1)}</span>
              ))}
            </div>
            {days.map((d) => (
              <DayColumn key={d} date={d} events={events} tasks={tasks} isToday={d === today} now={now} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/** The untimed "Tasks" area of one day. Accepts dropped tasks and dropped time blocks. */
function DayTasks({ date, tasks }: { date: string; tasks: Task[] }) {
  const actions = useActions();
  const { openTask } = useUI();
  const { settings } = useEnv();
  const [over, setOver] = useState(false);
  const [title, setTitle] = useState('');

  return (
    <div
      className={`tg-cell tasks-cell${over ? ' drop-over' : ''}`}
      data-testid={`tasks-${date}`}
      onDragOver={(e) => {
        if (drag && (drag.type === 'task' || drag.event.kind === 'task_block')) {
          e.preventDefault();
          setOver(true);
        }
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const d = drag;
        drag = null;
        if (!d) return;
        if (d.type === 'task') void actions.patchTask(d.id, { plannedDate: date }, 'Moved. Deadline unchanged.');
        else if (d.event.kind === 'task_block' && d.event.taskId) {
          // Back out of the timed schedule: remove the block, keep the task on this day.
          const taskId = d.event.taskId;
          void actions.deleteEvent(d.event.id, 'Moved back to the day’s tasks.').then(() => actions.patchTask(taskId, { plannedDate: date }));
        }
      }}
    >
      {tasks.map((t) => (
        <div
          key={t.id}
          className={`task-chip${t.status === 'done' ? ' finished' : ''}`}
          draggable={t.status === 'open'}
          data-task-id={t.id}
          onDragStart={(e) => {
            drag = { type: 'task', id: t.id, durationMin: t.estimateMin ?? settings.defaultBlockMin };
            e.dataTransfer.setData('text/plain', t.title);
            e.dataTransfer.effectAllowed = 'move';
          }}
          onDragEnd={() => (drag = null)}
        >
          <CheckButton task={t} small />
          <button className="chip-title" onClick={() => openTask(t.id)} title={`${t.title} — open to move or schedule`}>
            {t.title}
          </button>
        </div>
      ))}
      <input
        className="chip-add"
        value={title}
        placeholder="+ Task"
        aria-label={`Add task for ${formatDate(date, 'long')}`}
        maxLength={300}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && title.trim()) {
            void actions.createTask({ title: title.trim(), plannedDate: date });
            setTitle('');
          }
        }}
      />
    </div>
  );
}

/** The timed schedule of one day. */
function DayColumn({ date, events, tasks, isToday, now }: { date: string; events: CalEvent[]; tasks: Task[]; isToday: boolean; now: Date }) {
  const { tz, settings } = useEnv();
  const actions = useActions();
  const { newEvent } = useUI();
  const ref = useRef<HTMLDivElement>(null);
  const [preview, setPreview] = useState<{ top: number; height: number } | null>(null);
  const laid = useMemo(() => layoutSegments(segmentsForDay(events, date, tz)), [events, date, tz]);

  const minuteAt = (clientY: number) => ((clientY - ref.current!.getBoundingClientRect().top) / HOUR) * 60;
  const snap = (m: number) => Math.max(0, Math.min(1440 - SNAP, Math.round(m / SNAP) * SNAP));
  const dropStart = (clientY: number, d: DragState) => snap(minuteAt(clientY) - (d.type === 'event' ? d.grabMin : 0));

  const workDay = settings.workDays.includes(weekdayOf(date));
  const ws = timeToMinutes(settings.workStart);
  const we = timeToMinutes(settings.workEnd);
  const nowMin = isToday ? timeToMinutes(instantToZoned(now.toISOString(), tz).time) : null;

  return (
    <div
      ref={ref}
      className={`tg-daycol${isToday ? ' today' : ''}`}
      data-testid={`grid-${date}`}
      style={{ backgroundSize: `100% ${HOUR}px` }}
      onClick={(e) => {
        if (e.target !== ref.current) return;
        const m = snap(Math.floor(minuteAt(e.clientY) / 30) * 30);
        newEvent({ date, start: minutesToTime(m), end: minutesToTime(Math.min(1439, m + settings.defaultBlockMin)) });
      }}
      onDragOver={(e) => {
        if (!drag) return;
        e.preventDefault();
        const top = (dropStart(e.clientY, drag) / 60) * HOUR;
        setPreview({ top, height: (drag.durationMin / 60) * HOUR });
      }}
      onDragLeave={() => setPreview(null)}
      onDrop={(e) => {
        e.preventDefault();
        setPreview(null);
        const d = drag;
        drag = null;
        if (!d) return;
        const startAt = zonedToInstant(date, minutesToTime(dropStart(e.clientY, d)), tz);
        const endAt = addMinutes(startAt, d.durationMin);
        if (d.type === 'task') void actions.scheduleTask(d.id, startAt, endAt);
        else void actions.moveEvent(d.event, { startAt, endAt });
      }}
    >
      {workDay && we > ws && <div className="work-hours" style={{ top: (ws / 60) * HOUR, height: ((we - ws) / 60) * HOUR }} aria-hidden />}
      {laid.map((s) => (
        <EventBox key={s.event.id} seg={s} date={date} task={tasks.find((t) => t.id === s.event.taskId)} />
      ))}
      {preview && <div className="drop-preview" style={preview} aria-hidden />}
      {nowMin != null && <div className="now-line" style={{ top: (nowMin / 60) * HOUR }} aria-hidden />}
    </div>
  );
}

function EventBox({ seg, date, task }: { seg: LaidOut; date: string; task?: Task }) {
  const { tz, settings } = useEnv();
  const { openEvent } = useUI();
  const actions = useActions();
  const e = seg.event;
  const isBlock = e.kind === 'task_block';
  const [resizeEnd, setResizeEnd] = useState<number | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const endMin = resizeEnd ?? seg.endMin;
  const done = isBlock && task?.status === 'done';
  const g = e.google;
  const isTraining = e.kind === 'training';
  const locked = !!g?.readOnly || isTraining;
  const source = isTraining
    ? `${e.training?.what === 'completed' ? 'Completed activity' : 'Planned workout'} from Intervals.icu, read-only`
    : g ? `Google calendar ${g.calendarName}${locked ? ', read-only' : ''}` : isBlock ? 'Time block for task' : 'Event';
  const times = `${formatTime(e.startAt!, tz, settings.hour12)}–${formatTime(e.endAt!, tz, settings.hour12)}`;
  const height = Math.max(((endMin - seg.startMin) / 60) * HOUR, 18);

  return (
    <div
      ref={box}
      className={`ev ${isBlock ? 'ev-block' : isTraining ? 'ev-training' : 'ev-event'}${g ? ' ev-google' : ''}${locked && !isTraining ? ' ev-readonly' : ''}${seg.conflict ? ' conflict' : ''}${done ? ' finished' : ''}`}
      style={{
        borderLeftColor: g?.color ?? undefined,
        top: (seg.startMin / 60) * HOUR,
        height,
        left: `calc(${(seg.col / seg.cols) * 100}% + 2px)`,
        width: `calc(${100 / seg.cols}% - 4px)`,
      }}
      role="button"
      tabIndex={0}
      draggable={resizeEnd == null && !locked}
      data-event-id={e.id}
      aria-label={`${source}: ${e.title}, ${times}${seg.conflict ? ', overlaps another item' : ''}`}
      title={`${e.title}\n${times}\n${source}${seg.conflict ? '\nOverlaps another item' : ''}`}
      onClick={(ev) => {
        ev.stopPropagation();
        openEvent(e);
      }}
      onKeyDown={(ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          openEvent(e);
        }
      }}
      onDragStart={(ev) => {
        const grab = ((ev.clientY - box.current!.getBoundingClientRect().top) / HOUR) * 60;
        drag = { type: 'event', event: e, durationMin: minutesBetween(e.startAt!, e.endAt!), grabMin: grab };
        ev.dataTransfer.setData('text/plain', e.title);
        ev.dataTransfer.effectAllowed = 'move';
      }}
      onDragEnd={() => (drag = null)}
    >
      <div className="ev-inner">
        {isBlock && task && <CheckButton task={task} small />}
        <div className="ev-text">
          <span className="ev-title">{seg.conflict && <span className="conflict-mark" aria-hidden>⚠ </span>}{e.title || 'Untitled'}</span>
          {height > 30 && <span className="ev-time">{times}{e.location ? ` · ${e.location}` : ''}</span>}
          {g && height > 48 && <span className="ev-time">{locked ? 'Read-only · ' : ''}{g.calendarName}</span>}
          {isTraining && height > 48 && <span className="ev-time">{e.training?.what === 'completed' ? 'Completed' : 'Planned'} · Intervals.icu</span>}
          {e.mirror?.state === 'failed' && <span className="ev-time conflict-mark" title={e.mirror.error ?? ''}>Google copy not updated</span>}
        </div>
      </div>
      {!seg.continuesAfter && !locked && (
        <div
          className="ev-resize"
          aria-hidden
          onClick={(ev) => ev.stopPropagation()}
          onPointerDown={(ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            (ev.target as HTMLElement).setPointerCapture(ev.pointerId);
            setResizeEnd(seg.endMin);
          }}
          onPointerMove={(ev) => {
            if (resizeEnd == null) return;
            const top = box.current!.getBoundingClientRect().top;
            const m = seg.startMin + ((ev.clientY - top) / HOUR) * 60;
            setResizeEnd(Math.max(seg.startMin + SNAP, Math.min(1440, Math.round(m / SNAP) * SNAP)));
          }}
          onPointerUp={() => {
            if (resizeEnd == null) return;
            const m = resizeEnd;
            setResizeEnd(null);
            if (m === seg.endMin) return;
            const endAt = m >= 1440 ? dayBounds(date, tz).end : zonedToInstant(date, minutesToTime(m), tz);
            void actions.moveEvent(e, { endAt });
          }}
          onPointerCancel={() => setResizeEnd(null)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------- Month

function MonthView({ days, month, tasks, events, onDay }: { days: string[]; month: string; tasks: Task[]; events: CalEvent[]; onDay: (d: string) => void }) {
  const { today, tz, settings } = useEnv();
  const { openTask, openEvent } = useUI();
  const actions = useActions();
  const MAX = 4;
  return (
    <div className="month" role="grid" aria-label="Month">
      <div className="month-head" role="row">
        {days.slice(0, 7).map((d) => (
          <div key={d} role="columnheader">{formatDate(d, 'weekday').slice(0, 3)}</div>
        ))}
      </div>
      <div className="month-grid">
        {days.map((d) => {
          const allDay = allDayEventsFor(events, d);
          const timed = segmentsForDay(events, d, tz);
          const dayTasks = untimedTasksFor(tasks, events, d, tz);
          const due = deadlinesOn(tasks, d);
          const items = [
            ...allDay.map((e) => (
              <button key={e.id} className="allday-pill" style={pill(e.google?.color)} onClick={() => openEvent(e)} title={`All-day event: ${e.title}`}>{e.title}</button>
            )),
            ...timed.map((s) => (
              <button key={s.event.id} className={`m-item ${s.event.kind === 'task_block' ? 'm-block' : s.event.kind === 'training' ? 'm-training' : 'm-event'}`} onClick={() => openEvent(s.event)}
                style={s.event.google?.color ? { borderLeftColor: s.event.google.color } : undefined}
                title={`${s.event.kind === 'task_block' ? 'Time block' : s.event.kind === 'training' ? 'Training' : s.event.google ? `Google · ${s.event.google.calendarName}` : 'Event'}: ${s.event.title}`}>
                <span className="m-time">{formatTime(s.event.startAt!, tz, settings.hour12)}</span> {s.event.title}
              </button>
            )),
            ...untimedTrainingFor(events, d).map((e) => (
              <button key={e.id} className="m-item m-training" onClick={() => openEvent(e)} title={`Training: ${e.title}`}>
                <span aria-hidden>{e.training?.what === 'completed' ? '✓' : '○'}</span> {e.title}
              </button>
            )),
            ...dayTasks.map((t) => (
              <button key={t.id} className={`m-item m-task${t.status === 'done' ? ' finished' : ''}`} onClick={() => openTask(t.id)} title={`Task: ${t.title}`}
                draggable={t.status === 'open'}
                onDragStart={(e) => {
                  drag = { type: 'task', id: t.id, durationMin: t.estimateMin ?? settings.defaultBlockMin };
                  e.dataTransfer.setData('text/plain', t.title);
                }}
                onDragEnd={() => (drag = null)}>
                <span className="m-box" aria-hidden>{t.status === 'done' ? '☑' : '☐'}</span> {t.title}
              </button>
            )),
            ...due.map((t) => (
              <button key={`due-${t.id}`} className="deadline-flag" onClick={() => openTask(t.id)} title={`Deadline: ${t.title}`}>
                <span aria-hidden>⚑</span> Due: {t.title}
              </button>
            )),
          ];
          return (
            <div
              key={d}
              role="gridcell"
              className={`month-cell${d.slice(0, 7) !== month ? ' other' : ''}${d === today ? ' today' : ''}`}
              data-testid={`month-${d}`}
              onDragOver={(e) => {
                if (drag?.type === 'task') e.preventDefault();
              }}
              onDrop={(e) => {
                e.preventDefault();
                const dr = drag;
                drag = null;
                if (dr?.type === 'task') void actions.patchTask(dr.id, { plannedDate: d }, 'Moved. Deadline unchanged.');
              }}
            >
              <button className="month-date" onClick={() => onDay(d)} aria-label={`Open ${formatDate(d, 'long')}`}>
                {Number(d.slice(8))}
              </button>
              {items.slice(0, MAX)}
              {items.length > MAX && (
                <button className="m-more" onClick={() => onDay(d)}>+{items.length - MAX} more</button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Agenda

function AgendaView({ days, tasks, events, onDay }: { days: string[]; tasks: Task[]; events: CalEvent[]; onDay: (d: string) => void }) {
  const { today, tz, settings } = useEnv();
  const { openTask, openEvent, newTask } = useUI();
  return (
    <div className="agenda">
      {days.map((d) => {
        const allDay = allDayEventsFor(events, d);
        const timed = layoutSegments(segmentsForDay(events, d, tz));
        const dayTasks = untimedTasksFor(tasks, events, d, tz);
        const due = deadlinesOn(tasks, d);
        const training = untimedTrainingFor(events, d);
        const empty = !allDay.length && !timed.length && !dayTasks.length && !due.length && !training.length;
        return (
          <section key={d} className={`agenda-day${d === today ? ' today' : ''}`}>
            <h2>
              <button className="link" onClick={() => onDay(d)}>{formatDate(d, 'long')}</button>
              {d === today && <span className="badge">Today</span>}
            </h2>
            {empty && <p className="empty">Nothing planned.</p>}
            {allDay.length > 0 && (
              <div className="agenda-group">
                <h3>All-day</h3>
                {allDay.map((e) => (
                  <button key={e.id} className="allday-pill" onClick={() => openEvent(e)}>{e.title}</button>
                ))}
              </div>
            )}
            {timed.length > 0 && (
              <div className="agenda-group">
                <h3>Timed schedule</h3>
                <ul className="sched-list">
                  {timed.map((s) => (
                    <li key={s.event.id}>
                      <button className={`sched-item ${s.event.kind === 'task_block' ? 'is-block' : s.event.kind === 'training' ? 'is-training' : 'is-event'}`} onClick={() => openEvent(s.event)}>
                        <span className="sched-time">{formatTime(s.event.startAt!, tz, settings.hour12)}–{formatTime(s.event.endAt!, tz, settings.hour12)}</span>
                        <span className="sched-title">{s.event.title}</span>
                        <span className="badge subtle">{s.event.kind === 'task_block' ? 'Task block' : s.event.kind === 'training' ? 'Training · Intervals.icu' : s.event.google ? `Google · ${s.event.google.calendarName}` : 'Event'}</span>
                        {s.conflict && <span className="badge danger">Overlap</span>}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {training.length > 0 && (
              <div className="agenda-group">
                <h3>Training (no set time)</h3>
                {training.map((e) => (
                  <button key={e.id} className={`training-pill${e.training?.what === 'completed' ? ' completed' : ''}`} onClick={() => openEvent(e)}>
                    <span aria-hidden>{e.training?.what === 'completed' ? '✓' : '○'}</span> {e.title}
                  </button>
                ))}
              </div>
            )}
            {(dayTasks.length > 0 || due.length > 0) && (
              <div className="agenda-group">
                <h3>Tasks for the day</h3>
                <ul className="sched-list">
                  {dayTasks.map((t) => (
                    <li key={t.id} className="agenda-task">
                      <CheckButton task={t} small />
                      <button className={`link plain${t.status === 'done' ? ' struck' : ''}`} onClick={() => openTask(t.id)}>{t.title}</button>
                    </li>
                  ))}
                  {due.map((t) => (
                    <li key={`due-${t.id}`}>
                      <button className="deadline-flag" onClick={() => openTask(t.id)}><span aria-hidden>⚑</span> Due: {t.title}</button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <button className="btn small ghost" onClick={() => newTask({ plannedDate: d })}>+ Task</button>
          </section>
        );
      })}
    </div>
  );
}
