import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { formatDate, relativeDate } from '../../../shared/dates';
import { bucketTasks, compareTasks, upcomingKey } from '../../../shared/logic';
import { LIFE_AREAS, type Project, type Task } from '../../../shared/types';
import { useActions, useTasks } from '../api';
import { AttachedNotes } from '../components/Notes';
import { TaskList } from '../components/TaskRow';
import { useEnv } from '../env';
import { Dialog, useUI } from '../ui';

type Sort = 'smart' | 'due' | 'planned' | 'priority' | 'created' | 'title';
const VIEWS = [
  ['inbox', 'Inbox'], ['today', 'Today'], ['upcoming', 'Upcoming'], ['overdue', 'Overdue'], ['all', 'All open'], ['done', 'Completed'],
] as const;

function sortTasks(tasks: Task[], sort: Sort): Task[] {
  const key = (v: string | null) => v ?? '9999';
  const by: Record<Sort, (a: Task, b: Task) => number> = {
    smart: compareTasks,
    due: (a, b) => key(a.dueDate).localeCompare(key(b.dueDate)) || compareTasks(a, b),
    planned: (a, b) => key(a.plannedDate).localeCompare(key(b.plannedDate)) || compareTasks(a, b),
    priority: (a, b) => b.priority - a.priority || compareTasks(a, b),
    created: (a, b) => b.createdAt.localeCompare(a.createdAt),
    title: (a, b) => a.title.localeCompare(b.title),
  };
  return [...tasks].sort(by[sort]);
}

export function TasksPage() {
  const { now, tz, today, projects } = useEnv();
  const tasksQ = useTasks();
  const actions = useActions();
  const { newTask } = useUI();
  const [params, setParams] = useSearchParams();
  const view = params.get('view') ?? 'inbox';
  const q = params.get('q') ?? '';
  const [sort, setSort] = useState<Sort>('smart');
  const [minPriority, setMinPriority] = useState(0);
  const [tag, setTag] = useState('');
  const [title, setTitle] = useState('');
  const [projectDialog, setProjectDialog] = useState<Project | 'new' | null>(null);
  const setParam = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
  };

  const tasks = tasksQ.data ?? [];
  const buckets = useMemo(() => bucketTasks(tasks, now, tz), [tasks, now, tz]);
  const allTags = useMemo(() => [...new Set(tasks.flatMap((t) => t.tags))].sort(), [tasks]);
  const project = view.startsWith('p:') ? projects.find((p) => p.id === view.slice(2)) : undefined;

  let base: Task[];
  if (q) base = tasks; // search looks everywhere, including completed tasks
  else if (view === 'inbox') base = buckets.inbox;
  else if (view === 'today') base = [...buckets.today];
  else if (view === 'upcoming') base = buckets.upcoming;
  else if (view === 'overdue') base = [...buckets.overdue, ...buckets.missed];
  else if (view === 'done') base = tasks.filter((t) => t.status !== 'open').sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? ''));
  else if (project) base = tasks.filter((t) => t.projectId === project.id && t.status === 'open');
  else base = tasks.filter((t) => t.status === 'open');

  const needle = q.trim().toLowerCase();
  let shown = base.filter(
    (t) =>
      t.priority >= minPriority &&
      (!tag || t.tags.includes(tag)) &&
      (!needle ||
        t.title.toLowerCase().includes(needle) ||
        t.notes.toLowerCase().includes(needle) ||
        t.tags.some((x) => x.toLowerCase().includes(needle)) ||
        t.subtasks.some((s) => s.title.toLowerCase().includes(needle))),
  );
  const keepOrder = !q && sort === 'smart' && (view === 'upcoming' || view === 'done');
  if (!keepOrder) shown = sortTasks(shown, sort);

  const counts: Record<string, number> = {
    inbox: buckets.inbox.length, today: buckets.today.length, upcoming: buckets.upcoming.length,
    overdue: buckets.overdue.length + buckets.missed.length,
  };
  const heading = q ? `Search: “${q}”` : project ? project.name : VIEWS.find((v) => v[0] === view)?.[1] ?? 'All open';

  const addTask = () => {
    if (!title.trim()) return;
    void actions.createTask({
      title: title.trim(),
      plannedDate: view === 'today' ? today : null,
      projectId: project?.id ?? null,
    });
    setTitle('');
  };

  // Upcoming is grouped by the next relevant day (planned day or deadline).
  const groups =
    view === 'upcoming' && !q && sort === 'smart'
      ? [...Map.groupBy(shown, (t) => upcomingKey(t, today)).entries()]
      : null;

  return (
    <div className="page tasks-page">
      <nav className="task-nav" aria-label="Task views">
        <ul>
          {VIEWS.map(([id, label]) => (
            <li key={id}>
              <button className={!q && view === id ? 'on' : ''} onClick={() => setParams({ view: id }, { replace: true })}>
                {label}
                {counts[id] ? <span className={`count${id === 'overdue' ? ' danger' : ''}`}>{counts[id]}</span> : null}
              </button>
            </li>
          ))}
        </ul>
        <h2>Projects</h2>
        <ul>
          {LIFE_AREAS.concat([...new Set(projects.map((p) => p.area))].filter((a) => !(LIFE_AREAS as readonly string[]).includes(a)) as never[]).map((area) => {
            const ps = projects.filter((p) => p.area === area && !p.archived);
            if (!ps.length) return null;
            return (
              <li key={area}>
                <span className="area">{area}</span>
                <ul>
                  {ps.map((p) => (
                    <li key={p.id}>
                      <button className={!q && view === `p:${p.id}` ? 'on' : ''} onClick={() => setParams({ view: `p:${p.id}` }, { replace: true })}>
                        <span className="dot" style={{ background: p.color }} aria-hidden /> {p.name}
                        <span className="count">{tasks.filter((t) => t.projectId === p.id && t.status === 'open').length || ''}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </li>
            );
          })}
        </ul>
        <button className="btn small ghost" onClick={() => setProjectDialog('new')}>+ New project</button>
      </nav>

      <div className="task-content">
        <header className="page-head">
          <h1>{heading}</h1>
          {project && <button className="btn small ghost" onClick={() => setProjectDialog(project)}>Edit project</button>}
          <span className="spacer" />
          <button className="btn primary" onClick={() => newTask({ plannedDate: view === 'today' ? today : null, projectId: project?.id ?? null })}>New task</button>
        </header>

        <div className="filters">
          <input type="search" value={q} placeholder="Search tasks…" aria-label="Search tasks" onChange={(e) => setParam('q', e.target.value)} />
          <label>
            <span>Sort</span>
            <select value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
              <option value="smart">Smart</option>
              <option value="due">Deadline</option>
              <option value="planned">Planned day</option>
              <option value="priority">Priority</option>
              <option value="created">Newest</option>
              <option value="title">Title</option>
            </select>
          </label>
          <label>
            <span>Priority</span>
            <select value={minPriority} onChange={(e) => setMinPriority(Number(e.target.value))}>
              <option value={0}>Any</option>
              <option value={1}>Low and up</option>
              <option value={2}>Medium and up</option>
              <option value={3}>High only</option>
            </select>
          </label>
          {allTags.length > 0 && (
            <label>
              <span>Tag</span>
              <select value={tag} onChange={(e) => setTag(e.target.value)}>
                <option value="">Any</option>
                {allTags.map((t) => (
                  <option key={t} value={t}>#{t}</option>
                ))}
              </select>
            </label>
          )}
        </div>

        {!q && view !== 'done' && view !== 'overdue' && view !== 'upcoming' && (
          <div className="inline-add big">
            <input
              value={title}
              placeholder={view === 'today' ? 'Add a task for today…' : project ? `Add a task to ${project.name}…` : 'Add a task to the Inbox…'}
              aria-label="New task title"
              maxLength={300}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addTask()}
            />
            <button className="btn" onClick={addTask} disabled={!title.trim()}>Add</button>
          </div>
        )}

        {project?.notes && <p className="project-notes">{project.notes}</p>}
        {project && !q && (
          <details className="group project-notes-box">
            <summary>Project notes</summary>
            <AttachedNotes projectId={project.id} />
          </details>
        )}
        {tasksQ.isLoading && <p className="empty">Loading tasks…</p>}
        {tasksQ.isError && <p className="banner error" role="alert">Could not load tasks. Check that the server is running, then reload.</p>}

        {tasksQ.isSuccess &&
          (groups ? (
            groups.length === 0 ? (
              <p className="empty">Nothing upcoming.</p>
            ) : (
              groups.map(([day, list]) => (
                <section key={day} className="group-block">
                  <h3>{relativeDate(day, today)} <span className="muted small">{formatDate(day, 'long')}</span></h3>
                  <TaskList tasks={list} empty="" />
                </section>
              ))
            )
          ) : (
            <TaskList
              tasks={shown}
              empty={
                q ? 'No tasks match your search.'
                : view === 'inbox' ? 'Inbox is empty. Tasks without a planned day or project land here.'
                : view === 'overdue' ? 'Nothing overdue or missed.'
                : view === 'done' ? 'No completed tasks in the last 60 days.'
                : 'No tasks here.'
              }
            />
          ))}
      </div>

      {projectDialog && <ProjectDialog project={projectDialog === 'new' ? undefined : projectDialog} onClose={() => setProjectDialog(null)} onDeleted={() => setParams({ view: 'inbox' })} />}
    </div>
  );
}

function ProjectDialog({ project, onClose, onDeleted }: { project?: Project; onClose: () => void; onDeleted: () => void }) {
  const actions = useActions();
  const [name, setName] = useState(project?.name ?? '');
  const [area, setArea] = useState(project?.area ?? 'Personal');
  const [color, setColor] = useState(project?.color ?? '#5b7c99');
  const [notes, setNotes] = useState(project?.notes ?? '');
  const save = async () => {
    if (!name.trim()) return;
    const ok = project
      ? await actions.patchProject(project.id, { name: name.trim(), area, color, notes })
      : await actions.createProject({ name: name.trim(), area, color });
    if (ok) onClose();
  };
  return (
    <Dialog title={project ? 'Edit project' : 'New project'} onClose={onClose}>
      <form className="form" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <label className="field"><span>Name</span><input autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={100} required /></label>
        <div className="field-row">
          <label className="field">
            <span>Life area</span>
            <select value={area} onChange={(e) => setArea(e.target.value)}>
              {LIFE_AREAS.map((a) => <option key={a}>{a}</option>)}
            </select>
          </label>
          <label className="field"><span>Colour</span><input type="color" value={color} onChange={(e) => setColor(e.target.value)} /></label>
        </div>
        {project && <label className="field"><span>Description</span><textarea rows={4} value={notes} onChange={(e) => setNotes(e.target.value)} /></label>}
        <footer className="dialog-foot">
          {project && (
            <div className="btn-group">
              <button type="button" className="btn ghost" onClick={() => void actions.patchProject(project.id, { archived: true }).then(() => { onDeleted(); onClose(); })}>Archive</button>
              <button type="button" className="btn ghost danger" onClick={() => {
                if (confirm(`Delete project "${project.name}"? Its tasks are kept and moved to "No project".`)) void actions.deleteProject(project.id).then(() => { onDeleted(); onClose(); });
              }}>Delete</button>
            </div>
          )}
          <span className="spacer" />
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn primary">{project ? 'Save' : 'Add project'}</button>
        </footer>
      </form>
    </Dialog>
  );
}
