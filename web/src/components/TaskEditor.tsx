import { useEffect, useState } from 'react';
import {
  addDays, addMinutes, formatDate, formatTime, instantToZoned, minutesBetween, zonedToInstant,
} from '../../../shared/dates';
import { LIFE_AREAS, PRIORITY_LABELS, type Recurrence, type Task, type TaskCreate, type TaskPatch } from '../../../shared/types';
import { useActions, useTaskBlocks, useTaskHistory, useTasks } from '../api';
import { useEnv } from '../env';
import { Dialog, useUI } from '../ui';
import { AttachedNotes } from './Notes';

interface Draft {
  title: string; notes: string; priority: number; projectId: string | null; tags: string; estimateMin: string;
  plannedDate: string; dueDate: string; dueTime: string; focus: boolean;
  recFreq: '' | Recurrence['freq']; recInterval: string; recWeekdays: number[];
  remindDate: string; remindTime: string;
}

function toDraft(t: Partial<Task> | Partial<TaskCreate>, tz: string): Draft {
  const r = t.remindAt ? instantToZoned(t.remindAt, tz) : null;
  return {
    title: t.title ?? '', notes: t.notes ?? '', priority: t.priority ?? 0, projectId: t.projectId ?? null,
    tags: (t.tags ?? []).join(', '), estimateMin: t.estimateMin ? String(t.estimateMin) : '',
    plannedDate: t.plannedDate ?? '', dueDate: t.dueDate ?? '', dueTime: t.dueTime ?? '', focus: t.focus ?? false,
    recFreq: t.recurrence?.freq ?? '', recInterval: String(t.recurrence?.interval ?? 1), recWeekdays: t.recurrence?.weekdays ?? [],
    remindDate: r?.date ?? '', remindTime: r?.time ?? '',
  };
}

function fromDraft(d: Draft, tz: string) {
  const recurrence: Recurrence | null = d.recFreq
    ? {
        freq: d.recFreq,
        interval: Math.max(1, Number(d.recInterval) || 1),
        ...(d.recFreq === 'weekly' && d.recWeekdays.length ? { weekdays: d.recWeekdays } : {}),
      }
    : null;
  return {
    title: d.title.trim(), notes: d.notes, priority: d.priority, projectId: d.projectId,
    tags: [...new Set(d.tags.split(',').map((s) => s.trim().replace(/^#/, '')).filter(Boolean))],
    estimateMin: d.estimateMin ? Math.max(1, Math.round(Number(d.estimateMin))) : null,
    plannedDate: d.plannedDate || null, dueDate: d.dueDate || null, dueTime: d.dueDate && d.dueTime ? d.dueTime : null,
    focus: d.focus, recurrence,
    remindAt: d.remindDate ? zonedToInstant(d.remindDate, d.remindTime || '09:00', tz) : null,
  };
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function TaskEditor() {
  const { taskEditor, closeEditors } = useUI();
  const tasks = useTasks();
  if (!taskEditor) return null;
  if ('id' in taskEditor) {
    const task = tasks.data?.find((t) => t.id === taskEditor.id);
    if (!task) return null;
    return <TaskForm key={task.id} task={task} onClose={closeEditors} />;
  }
  return <TaskForm key="new" defaults={taskEditor.defaults} onClose={closeEditors} />;
}

function TaskForm({ task, defaults, onClose }: { task?: Task; defaults?: Partial<TaskCreate>; onClose: () => void }) {
  const { tz, today, projects, settings } = useEnv();
  const actions = useActions();
  const [d, setD] = useState<Draft>(() => toDraft(task ?? defaults ?? {}, tz));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((cur) => ({ ...cur, [k]: v }));
  const original = task ? fromDraft(toDraft(task, tz), tz) : null;

  async function save() {
    if (!d.title.trim()) return setError('Give the task a title.');
    const next = fromDraft(d, tz);
    if (next.recurrence && !next.plannedDate && !next.dueDate) return setError('A repeating task needs a planned day or a deadline.');
    setError('');
    setBusy(true);
    let ok: unknown;
    if (task && original) {
      // Send only the fields that changed, so untouched dates can never be rewritten.
      const patch: Record<string, unknown> = {};
      for (const k of Object.keys(next) as (keyof typeof next)[]) {
        if (JSON.stringify(next[k]) !== JSON.stringify(original[k])) patch[k] = next[k];
      }
      ok = Object.keys(patch).length ? await actions.patchTask(task.id, patch as TaskPatch, 'Task saved') : true;
    } else {
      ok = await actions.createTask(next);
    }
    setBusy(false);
    if (ok) onClose();
  }

  const activeProjects = projects.filter((p) => !p.archived || p.id === d.projectId);

  return (
    <Dialog title={task ? 'Edit task' : 'New task'} onClose={onClose} wide>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <label className="field">
          <span>Title</span>
          <input autoFocus={!task} value={d.title} onChange={(e) => set('title', e.target.value)} maxLength={300} required />
        </label>

        <div className="field-row">
          <label className="field">
            <span>Planned day</span>
            <input type="date" value={d.plannedDate} onChange={(e) => set('plannedDate', e.target.value)} />
          </label>
          <div className="field">
            <span aria-hidden>&nbsp;</span>
            <div className="btn-group">
              <button type="button" className="btn small" onClick={() => set('plannedDate', today)}>Today</button>
              <button type="button" className="btn small" onClick={() => set('plannedDate', addDays(today, 1))}>Tomorrow</button>
              <button type="button" className="btn small" onClick={() => set('plannedDate', '')}>No day</button>
            </div>
          </div>
        </div>
        <div className="field-row">
          <label className="field">
            <span>Deadline</span>
            <input type="date" value={d.dueDate} onChange={(e) => set('dueDate', e.target.value)} />
          </label>
          <label className="field">
            <span>Deadline time (optional)</span>
            <input type="time" value={d.dueTime} disabled={!d.dueDate} onChange={(e) => set('dueTime', e.target.value)} />
          </label>
        </div>
        <p className="hint">The planned day is when you intend to work on it. Changing it never changes the deadline.</p>

        <div className="field-row three">
          <label className="field">
            <span>Priority</span>
            <select value={d.priority} onChange={(e) => set('priority', Number(e.target.value))}>
              {PRIORITY_LABELS.map((l, i) => (
                <option key={l} value={i}>{l}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Project</span>
            <select value={d.projectId ?? ''} onChange={(e) => set('projectId', e.target.value || null)}>
              <option value="">No project</option>
              {LIFE_AREAS.concat(
                [...new Set(activeProjects.map((p) => p.area))].filter((a) => !(LIFE_AREAS as readonly string[]).includes(a)) as never[],
              ).map((area) => {
                const ps = activeProjects.filter((p) => p.area === area);
                return ps.length ? (
                  <optgroup key={area} label={area}>
                    {ps.map((p) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </optgroup>
                ) : null;
              })}
            </select>
          </label>
          <label className="field">
            <span>Estimate (minutes)</span>
            <input type="number" min={1} max={1440} inputMode="numeric" value={d.estimateMin} onChange={(e) => set('estimateMin', e.target.value)} />
          </label>
        </div>

        <label className="field">
          <span>Tags (comma separated)</span>
          <input value={d.tags} onChange={(e) => set('tags', e.target.value)} placeholder="errand, phone" />
        </label>

        <label className="field">
          <span>Description</span>
          <textarea rows={3} value={d.notes} onChange={(e) => set('notes', e.target.value)} />
        </label>

        <label className="check-field">
          <input type="checkbox" checked={d.focus} onChange={(e) => set('focus', e.target.checked)} />
          <span>Top priority (shown in "Top three" on Today)</span>
        </label>

        <fieldset className="group">
          <legend>Repeat</legend>
          <div className="field-row">
            <label className="field">
              <span>Frequency</span>
              <select value={d.recFreq} onChange={(e) => set('recFreq', e.target.value as Draft['recFreq'])}>
                <option value="">Does not repeat</option>
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly</option>
                <option value="yearly">Yearly</option>
              </select>
            </label>
            {d.recFreq && (
              <label className="field">
                <span>Every</span>
                <input type="number" min={1} max={365} value={d.recInterval} onChange={(e) => set('recInterval', e.target.value)} />
              </label>
            )}
          </div>
          {d.recFreq === 'weekly' && (
            <div className="weekday-picks" role="group" aria-label="Repeat on weekdays">
              {WEEKDAYS.map((n, i) => (
                <label key={n} className="chip-check">
                  <input
                    type="checkbox"
                    checked={d.recWeekdays.includes(i + 1)}
                    onChange={(e) =>
                      set('recWeekdays', e.target.checked ? [...d.recWeekdays, i + 1].sort() : d.recWeekdays.filter((x) => x !== i + 1))
                    }
                  />
                  <span>{n}</span>
                </label>
              ))}
            </div>
          )}
          {d.recFreq && <p className="hint">When you complete it, the finished task is kept and the next occurrence is created.</p>}
        </fieldset>

        <fieldset className="group">
          <legend>Reminder</legend>
          <div className="field-row">
            <label className="field">
              <span>Date</span>
              <input type="date" value={d.remindDate} onChange={(e) => set('remindDate', e.target.value)} />
            </label>
            <label className="field">
              <span>Time</span>
              <input type="time" value={d.remindTime} disabled={!d.remindDate} onChange={(e) => set('remindTime', e.target.value)} />
            </label>
          </div>
          {task && task.reminderStatus !== 'none' && (
            <p className="hint">
              Status: {task.reminderStatus === 'pending' ? 'scheduled' : task.reminderStatus}. Reminders are shown while the dashboard is open in a browser.
            </p>
          )}
        </fieldset>

        {task && <Subtasks task={task} />}
        {task && (
          <fieldset className="group">
            <legend>Dated notes</legend>
            <AttachedNotes taskId={task.id} />
          </fieldset>
        )}
        {task && <Blocks task={task} />}
        {task && <History task={task} />}

        {error && <p className="form-error" role="alert">{error}</p>}

        <footer className="dialog-foot">
          {task && (
            <div className="btn-group">
              {task.status === 'open' ? (
                <>
                  <button type="button" className="btn" onClick={() => void actions.completeTask(task.id).then(onClose)}>Complete</button>
                  <button type="button" className="btn ghost" onClick={() => void actions.dismissTask(task.id).then(onClose)}>Dismiss</button>
                </>
              ) : (
                <button type="button" className="btn" onClick={() => void actions.reopenTask(task.id)}>Reopen</button>
              )}
              <button
                type="button"
                className="btn ghost danger"
                onClick={() => {
                  if (confirm(`Delete "${task.title}"? This also removes its time blocks and history.`)) void actions.deleteTask(task.id).then(onClose);
                }}
              >
                Delete
              </button>
            </div>
          )}
          <span className="spacer" />
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn primary" disabled={busy}>{busy ? 'Saving…' : task ? 'Save' : 'Add task'}</button>
        </footer>
        <p className="hint right">Times use {settings.timezone}.</p>
      </form>
    </Dialog>
  );
}

function Subtasks({ task }: { task: Task }) {
  const actions = useActions();
  const [title, setTitle] = useState('');
  const add = () => {
    if (!title.trim()) return;
    void actions.addSubtask(task.id, title.trim());
    setTitle('');
  };
  return (
    <fieldset className="group">
      <legend>Subtasks</legend>
      <ul className="sub-list">
        {task.subtasks.map((s) => (
          <li key={s.id}>
            <label className="check-field">
              <input type="checkbox" checked={s.done} onChange={(e) => void actions.patchSubtask(s.id, { done: e.target.checked })} />
              <span className={s.done ? 'struck' : ''}>{s.title}</span>
            </label>
            <button type="button" className="icon-btn" aria-label={`Delete subtask ${s.title}`} onClick={() => void actions.deleteSubtask(s.id)}>×</button>
          </li>
        ))}
      </ul>
      <div className="inline-add">
        <input
          value={title}
          placeholder="Add a subtask"
          aria-label="New subtask"
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
        />
        <button type="button" className="btn small" onClick={add}>Add</button>
      </div>
    </fieldset>
  );
}

/** Click/tap alternative to dragging: add, change or remove the task's time blocks. */
function Blocks({ task }: { task: Task }) {
  const { tz, today, settings } = useEnv();
  const actions = useActions();
  const blocks = useTaskBlocks(task.id);
  const [date, setDate] = useState(task.plannedDate ?? today);
  const [start, setStart] = useState('09:00');
  const [dur, setDur] = useState(String(task.estimateMin ?? settings.defaultBlockMin));
  useEffect(() => setDate(task.plannedDate ?? today), [task.plannedDate, today]);

  return (
    <fieldset className="group">
      <legend>Time blocks</legend>
      {blocks.data?.length ? (
        <ul className="sub-list">
          {blocks.data.map((b) => (
            <li key={b.id}>
              <span>
                {formatDate(instantToZoned(b.startAt!, tz).date)} · {formatTime(b.startAt!, tz, settings.hour12)}–{formatTime(b.endAt!, tz, settings.hour12)}
                <span className="muted"> ({minutesBetween(b.startAt!, b.endAt!)} min)</span>
              </span>
              <button type="button" className="btn small ghost" onClick={() => void actions.deleteEvent(b.id, 'Removed from schedule. Task kept.')}>
                Remove from schedule
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="hint">Not on the timed schedule. Add a block here, or drag the task into the calendar.</p>
      )}
      <div className="field-row three">
        <label className="field">
          <span>Day</span>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        <label className="field">
          <span>Start</span>
          <input type="time" value={start} onChange={(e) => setStart(e.target.value)} />
        </label>
        <label className="field">
          <span>Minutes</span>
          <input type="number" min={5} max={720} step={5} value={dur} onChange={(e) => setDur(e.target.value)} />
        </label>
      </div>
      <button
        type="button"
        className="btn small"
        disabled={!date || !start}
        onClick={() => {
          const startAt = zonedToInstant(date, start, tz);
          void actions.scheduleTask(task.id, startAt, addMinutes(startAt, Math.max(5, Number(dur) || settings.defaultBlockMin)));
        }}
      >
        Add time block
      </button>
    </fieldset>
  );
}

function History({ task }: { task: Task }) {
  const { tz, settings } = useEnv();
  const [open, setOpen] = useState(false);
  const hist = useTaskHistory(task.id, open);
  const label: Record<string, string> = {
    created: 'Created', completed: 'Completed', dismissed: 'Dismissed', reopened: 'Reopened',
    rescheduled: 'Planned day changed', deadline_changed: 'Deadline changed',
  };
  return (
    <details className="group" onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary>History{task.seriesId ? ' (whole series)' : ''}</summary>
      {hist.isLoading && <p className="hint">Loading…</p>}
      {hist.isError && <p className="form-error">Could not load history.</p>}
      <ul className="history">
        {hist.data?.map((h) => (
          <li key={h.id}>
            <span className="muted">
              {formatDate(instantToZoned(h.at, tz).date)} {formatTime(h.at, tz, settings.hour12)}
            </span>{' '}
            {label[h.type] ?? h.type}
            {'to' in h.data ? `: ${(h.data.from as string) ?? 'none'} → ${(h.data.to as string) ?? 'none'}` : ''}
          </li>
        ))}
      </ul>
    </details>
  );
}
