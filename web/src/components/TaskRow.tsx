import { addDays, formatWallTime, relativeDate } from '../../../shared/dates';
import { describeRecurrence, isMissed, isOverdue } from '../../../shared/logic';
import { PRIORITY_LABELS, type Task } from '../../../shared/types';
import { useActions } from '../api';
import { useEnv } from '../env';
import { useUI } from '../ui';

export function CheckButton({ task, small }: { task: Task; small?: boolean }) {
  const actions = useActions();
  const done = task.status === 'done';
  return (
    <button
      type="button"
      className={`check${done ? ' done' : ''}${small ? ' small' : ''}`}
      role="checkbox"
      aria-checked={done}
      aria-label={done ? `Mark "${task.title}" as not done` : `Complete "${task.title}"`}
      onClick={(e) => {
        e.stopPropagation();
        void (done ? actions.reopenTask(task.id) : actions.completeTask(task.id));
      }}
    >
      {done ? '✓' : ''}
    </button>
  );
}

export function DueBadge({ task }: { task: Task }) {
  const { now, tz, today, settings } = useEnv();
  if (!task.dueDate) return null;
  const overdue = isOverdue(task, now, tz);
  const soon = !overdue && task.dueDate <= addDays(today, 2);
  return (
    <span className={`badge ${overdue ? 'danger' : soon ? 'warn' : ''}`}>
      {overdue ? 'Overdue: ' : 'Due '}
      {relativeDate(task.dueDate, today)}
      {task.dueTime ? ` ${formatWallTime(task.dueTime, settings.hour12)}` : ''}
    </span>
  );
}

/** One task line: complete, open, star, and quick reschedule without opening the editor. */
export function TaskRow({ task, hidePlanned, suggested }: { task: Task; hidePlanned?: boolean; suggested?: boolean }) {
  const { today, projects } = useEnv();
  const { openTask } = useUI();
  const actions = useActions();
  const project = projects.find((p) => p.id === task.projectId);
  const missed = isMissed(task, today);
  const open = task.status === 'open';
  const subDone = task.subtasks.filter((s) => s.done).length;

  return (
    <li className={`task-row${open ? '' : ' finished'}`} data-task-id={task.id}>
      <CheckButton task={task} />
      <div className="task-main">
        <button type="button" className="task-title" onClick={() => openTask(task.id)}>
          {task.title}
        </button>
        <div className="task-meta">
          {suggested && <span className="badge subtle">Suggested</span>}
          {task.status === 'dismissed' && <span className="badge subtle">Dismissed</span>}
          {task.priority > 0 && <span className={`badge prio p${task.priority}`}>{PRIORITY_LABELS[task.priority]}</span>}
          <DueBadge task={task} />
          {open && missed && <span className="badge warn">Missed {relativeDate(task.plannedDate!, today)}</span>}
          {open && !missed && !hidePlanned && task.plannedDate && (
            <span className="badge subtle">Planned {relativeDate(task.plannedDate, today)}</span>
          )}
          {project && (
            <span className="meta-item">
              <span className="dot" style={{ background: project.color }} aria-hidden />
              {project.name}
            </span>
          )}
          {task.estimateMin != null && <span className="meta-item">{task.estimateMin} min</span>}
          {task.recurrence && <span className="meta-item" title={describeRecurrence(task.recurrence)}>↻ {describeRecurrence(task.recurrence)}</span>}
          {task.subtasks.length > 0 && <span className="meta-item">{subDone}/{task.subtasks.length} subtasks</span>}
          {task.tags.map((t) => (
            <span key={t} className="meta-item tag">#{t}</span>
          ))}
        </div>
      </div>
      {open && (
        <div className="task-actions">
          <button
            type="button"
            className={`icon-btn star${task.focus ? ' on' : ''}`}
            aria-pressed={task.focus}
            aria-label={task.focus ? 'Remove from top priorities' : 'Add to top priorities'}
            title={task.focus ? 'Remove from top priorities' : 'Add to top priorities'}
            onClick={() => void actions.patchTask(task.id, { focus: !task.focus })}
          >
            {task.focus ? '★' : '☆'}
          </button>
          {task.plannedDate !== today && (
            <button type="button" className="btn small ghost" title="Plan for today (deadline unchanged)"
              onClick={() => void actions.patchTask(task.id, { plannedDate: today }, 'Planned for today')}>
              Today
            </button>
          )}
          <button type="button" className="btn small ghost" title="Plan for tomorrow (deadline unchanged)"
            onClick={() => void actions.patchTask(task.id, { plannedDate: addDays(today, 1) }, 'Moved to tomorrow. Deadline unchanged.')}>
            Tomorrow
          </button>
          {missed && (
            <button type="button" className="btn small ghost" title="Dismiss without completing"
              onClick={() => void actions.dismissTask(task.id)}>
              Dismiss
            </button>
          )}
        </div>
      )}
    </li>
  );
}

export function TaskList({ tasks, empty, hidePlanned }: { tasks: Task[]; empty: string; hidePlanned?: boolean }) {
  if (tasks.length === 0) return <p className="empty">{empty}</p>;
  return (
    <ul className="task-list">
      {tasks.map((t) => (
        <TaskRow key={t.id} task={t} hidePlanned={hidePlanned} />
      ))}
    </ul>
  );
}
