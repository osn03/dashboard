import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { NavLink, Navigate, Route, Routes, useNavigate } from 'react-router';
import { api, useMe, useProjects, useSettings } from './api';
import { AssistantPanel } from './components/Assistant';
import { EventEditor } from './components/EventEditor';
import { TaskEditor } from './components/TaskEditor';
import { EnvProvider } from './env';
import { CalendarPage } from './pages/Calendar';
import { ReviewPage } from './pages/Review';
import { TrainingPage } from './pages/Training';
import { SettingsPage } from './pages/Settings';
import { TasksPage } from './pages/Tasks';
import { TodayPage } from './pages/Today';
import { ErrorBoundary, Toasts, useUI } from './ui';
import type { Task } from '../../shared/types';

export function App() {
  const me = useMe();
  const qc = useQueryClient();
  useEffect(() => {
    const onExpired = () => void qc.invalidateQueries({ queryKey: ['me'] });
    window.addEventListener('auth-expired', onExpired);
    return () => window.removeEventListener('auth-expired', onExpired);
  }, [qc]);

  // Lets a launcher-started server know this tab is open (it stops when the last tab closes).
  // The connection is re-opened whenever it ends (sleep, a suspended tab, a restarted server).
  // A tab that is really closing says so, which lets the server stop promptly.
  useEffect(() => {
    let alive: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const connect = () => {
      clearTimeout(retry);
      if (stopped || (alive && alive.readyState !== EventSource.CLOSED)) return;
      alive?.close();
      alive = new EventSource('/api/auth/alive');
      alive.onerror = () => {
        // The browser retries dropped connections by itself, but gives up for good on an error response.
        if (alive?.readyState === EventSource.CLOSED) retry = setTimeout(connect, 3000);
      };
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') connect();
    };
    const onHide = () => {
      void fetch('/api/auth/bye', { method: 'POST', keepalive: true, credentials: 'same-origin', headers: { 'x-requested-with': 'dashboard' } }).catch(() => undefined);
    };
    connect();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('pageshow', connect);
    window.addEventListener('online', connect);
    window.addEventListener('pagehide', onHide);
    return () => {
      stopped = true;
      clearTimeout(retry);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('pageshow', connect);
      window.removeEventListener('online', connect);
      window.removeEventListener('pagehide', onHide);
      alive?.close();
    };
  }, []);

  if (me.isLoading) return <p className="splash">Loading…</p>;
  if (me.isError || !me.data) {
    return <Unreachable onBack={() => qc.invalidateQueries()} />;
  }
  if (!me.data.user) return <><AuthScreen setup={me.data.needsSetup} demo={me.data.demo} /><Toasts /></>;
  return <Shell username={me.data.user.username} demo={me.data.demo} />;
}

const serverUp = () =>
  fetch('/api/auth/me', { credentials: 'same-origin', signal: AbortSignal.timeout(1500) }).then((r) => r.ok, () => false);

/**
 * Shown when the server does not answer (for example it stopped while this tab was asleep).
 * The button starts it again through the claudedashboard:// link handled by Dashboard.vbs,
 * then waits for it to answer. The page also notices by itself when the server is back.
 */
function Unreachable({ onBack }: { onBack: () => unknown }) {
  const [state, setState] = useState<'down' | 'starting' | 'failed'>('down');
  useEffect(() => {
    if (state === 'starting') return;
    const timer = setInterval(() => void serverUp().then((up) => up && onBack()), 5000);
    return () => clearInterval(timer);
  }, [state, onBack]);

  async function restart() {
    setState('starting');
    if (!(await serverUp())) {
      window.location.href = 'claudedashboard://start'; // handled by Windows; this page stays open
      const until = Date.now() + 45_000;
      let up = false;
      while (!up && Date.now() < until) {
        await new Promise((r) => setTimeout(r, 1000));
        up = await serverUp();
      }
      if (!up) return setState('failed');
    }
    await onBack();
  }

  return (
    <div className="splash">
      <h1>Cannot reach the server</h1>
      <p>The dashboard’s server has stopped or is not responding. Your data is stored locally and is not affected.</p>
      {state === 'starting' && <p className="muted" role="status">Starting the server… If the browser asks whether to open Windows Script Host, allow it.</p>}
      {state === 'failed' && (
        <p className="form-error" role="alert">
          The server did not start. Double-click <code>Dashboard.vbs</code> in the project folder, or run <code>npm run dev</code>; this page reconnects by itself.
        </p>
      )}
      <button className="btn primary" disabled={state === 'starting'} onClick={() => void restart()}>
        {state === 'starting' ? 'Starting…' : 'Restart the server'}
      </button>
    </div>
  );
}

function AuthScreen({ setup, demo }: { setup: boolean; demo: boolean }) {
  const qc = useQueryClient();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit() {
    setError('');
    if (setup && password.length < 10) return setError('Use at least 10 characters for the password.');
    if (setup && password !== confirm) return setError('The two passwords do not match.');
    setBusy(true);
    try {
      await api('POST', setup ? '/api/auth/setup' : '/api/auth/login', { username: username.trim(), password });
      await qc.invalidateQueries();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not sign in');
    }
    setBusy(false);
  }
  return (
    <main className="auth">
      <form className="card form" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <h1>{setup ? 'Create your account' : 'Sign in'}</h1>
        {demo && <p className="banner demo">Demo mode: sample data in a separate database. Sign in with <strong>demo</strong> / <strong>demo-password</strong>.</p>}
        {setup && <p className="muted">First run: choose the username and password that protect this dashboard. They are stored only on this computer.</p>}
        <label className="field"><span>Username</span><input autoFocus autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required /></label>
        <label className="field"><span>Password</span><input type="password" autoComplete={setup ? 'new-password' : 'current-password'} value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
        {setup && <label className="field"><span>Repeat password</span><input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required /></label>}
        {error && <p className="form-error" role="alert">{error}</p>}
        <button className="btn primary" type="submit" disabled={busy}>{busy ? 'Please wait…' : setup ? 'Create account' : 'Sign in'}</button>
      </form>
    </main>
  );
}

const NAV = [
  ['/', 'Today', '◉'],
  ['/tasks', 'Tasks', '☑'],
  ['/calendar', 'Calendar', '▦'],
  ['/training', 'Training', '♥'],
  ['/review', 'Review', '✓'],
  ['/settings', 'Settings', '⚙'],
] as const;

function Shell({ username, demo }: { username: string; demo: boolean }) {
  const [assistantOpen, setAssistantOpen] = useState(false);
  const settings = useSettings();
  const projects = useProjects();

  const theme = settings.data?.theme ?? 'system';
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      document.documentElement.dataset.theme = theme === 'system' ? (mq.matches ? 'dark' : 'light') : theme;
    };
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [theme]);

  if (settings.isLoading || projects.isLoading) return <p className="splash">Loading…</p>;
  if (!settings.data || !projects.data) {
    return (
      <div className="splash">
        <h1>Could not load the dashboard</h1>
        <p>The server did not return your settings. Your data is not affected.</p>
        <button className="btn primary" onClick={() => { void settings.refetch(); void projects.refetch(); }}>Try again</button>
      </div>
    );
  }

  return (
    <EnvProvider settings={settings.data} projects={projects.data}>
      {demo && (
        <div className="demo-bar" role="status">
          DEMO MODE — sample data in a separate database (data/demo.db). Nothing here touches your real tasks, calendars or accounts.
        </div>
      )}
      <div className={`shell${demo ? ' with-demo' : ''}${assistantOpen ? ' with-assistant' : ''}`}>
        <a className="skip-link" href="#main">Skip to content</a>
        <nav className="sidebar" aria-label="Main">
          <div className="brand">Dashboard</div>
          <ul>
            {NAV.map(([to, label, icon]) => (
              <li key={to}>
                <NavLink to={to} end={to === '/'}>
                  <span className="nav-icon" aria-hidden>{icon}</span>
                  <span>{label}</span>
                </NavLink>
              </li>
            ))}
          </ul>
          <button className={`btn assistant-toggle${assistantOpen ? ' on' : ''}`} aria-pressed={assistantOpen} onClick={() => setAssistantOpen((o) => !o)} title="Open the assistant">
            <span aria-hidden>✦</span> <span className="add-label">Assistant</span>
          </button>
          <GlobalAdd />
          <div className="sidebar-foot muted">Signed in as {username}</div>
        </nav>
        <main id="main" className="main" tabIndex={-1}>
          <ErrorBoundary label="This page">
          <Routes>
            <Route path="/" element={<TodayPage />} />
            <Route path="/tasks" element={<TasksPage />} />
            <Route path="/calendar" element={<CalendarPage />} />
            <Route path="/training" element={<TrainingPage />} />
            <Route path="/review" element={<ReviewPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
          </ErrorBoundary>
        </main>
        {assistantOpen && (
          <ErrorBoundary label="The assistant">
            <AssistantPanel onClose={() => setAssistantOpen(false)} />
          </ErrorBoundary>
        )}
      </div>
      <TaskEditor />
      <EventEditor />
      <Toasts />
      <Reminders />
      <Shortcuts />
    </EnvProvider>
  );
}

function GlobalAdd() {
  const { newTask } = useUI();
  return (
    <button className="btn primary global-add" onClick={() => newTask()} title="New task (press N)">
      <span aria-hidden>+</span> <span className="add-label">New task</span>
    </button>
  );
}

/** Keyboard shortcuts: N = new task, / = search tasks, 1/2/3 = Today/Tasks/Calendar. */
function Shortcuts() {
  const { newTask, taskEditor, eventEditor } = useUI();
  const navigate = useNavigate();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (e.ctrlKey || e.metaKey || e.altKey || taskEditor || eventEditor) return;
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || el.isContentEditable) return;
      if (e.key === 'n') {
        e.preventDefault();
        newTask();
      } else if (e.key === '/') {
        e.preventDefault();
        navigate('/tasks');
        setTimeout(() => document.querySelector<HTMLInputElement>('input[type=search]')?.focus(), 50);
      } else if (e.key === '1') navigate('/');
      else if (e.key === '2') navigate('/tasks');
      else if (e.key === '3') navigate('/calendar');
      else if (e.key === '4') navigate('/training');
      else if (e.key === '5') navigate('/review');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [newTask, navigate, taskEditor, eventEditor]);
  return null;
}

/** Polls for due reminders while the app is open; shows them in-app and, if allowed, as notifications. */
function Reminders() {
  const { toast, openTask } = useUI();
  const qc = useQueryClient();
  useEffect(() => {
    let stopped = false;
    const check = async () => {
      try {
        const due = await api<Task[]>('GET', '/api/reminders/due');
        for (const t of due) {
          if (stopped) return;
          toast(`Reminder: ${t.title}`, { action: { label: 'Open', run: () => openTask(t.id) } });
          if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
            try {
              new Notification('Reminder', { body: t.title, tag: `task-${t.id}` });
            } catch {
              /* in-app toast was shown; that counts as delivered */
            }
          }
          await api('POST', `/api/reminders/${t.id}/ack`, { status: 'delivered' });
        }
        if (due.length) void qc.invalidateQueries({ queryKey: ['tasks'] });
      } catch {
        /* offline or signed out: reminders stay pending and are retried */
      }
    };
    void check();
    const timer = setInterval(check, 30_000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}
