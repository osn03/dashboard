// App-wide UI state: toasts and the task/event editor dialogs.
import { Component, createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { CalEvent, TaskCreate } from '../../shared/types';

export interface Toast {
  id: number;
  message: string;
  kind: 'info' | 'error';
  action?: { label: string; run: () => void };
}

export type TaskEditorState = { id: string } | { defaults: Partial<TaskCreate> } | null;
export type EventEditorState =
  | { event: CalEvent }
  | { defaults: { date: string; start?: string; end?: string; allDay?: boolean; title?: string } }
  | null;

interface UI {
  toasts: Toast[];
  toast: (message: string, opts?: { kind?: 'info' | 'error'; action?: Toast['action'] }) => void;
  dismissToast: (id: number) => void;
  taskEditor: TaskEditorState;
  eventEditor: EventEditorState;
  openTask: (id: string) => void;
  newTask: (defaults?: Partial<TaskCreate>) => void;
  openEvent: (event: CalEvent) => void;
  newEvent: (defaults: { date: string; start?: string; end?: string; allDay?: boolean; title?: string }) => void;
  closeEditors: () => void;
}

const Ctx = createContext<UI | null>(null);

export function UIProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [taskEditor, setTaskEditor] = useState<TaskEditorState>(null);
  const [eventEditor, setEventEditor] = useState<EventEditorState>(null);
  const seq = useRef(0);

  const dismissToast = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const toast = useCallback<UI['toast']>(
    (message, opts = {}) => {
      const id = ++seq.current;
      const kind = opts.kind ?? 'info';
      setToasts((t) => [...t.slice(-3), { id, message, kind, action: opts.action }]);
      // Errors stay until dismissed; confirmations fade.
      if (kind === 'info') setTimeout(() => dismissToast(id), opts.action ? 8000 : 4000);
    },
    [dismissToast],
  );

  const value = useMemo<UI>(
    () => ({
      toasts,
      toast,
      dismissToast,
      taskEditor,
      eventEditor,
      openTask: (id) => setTaskEditor({ id }),
      newTask: (defaults = {}) => setTaskEditor({ defaults }),
      openEvent: (event) => setEventEditor({ event }),
      newEvent: (defaults) => setEventEditor({ defaults }),
      closeEditors: () => {
        setTaskEditor(null);
        setEventEditor(null);
      },
    }),
    [toasts, toast, dismissToast, taskEditor, eventEditor],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useUI(): UI {
  const v = useContext(Ctx);
  if (!v) throw new Error('UIProvider missing');
  return v;
}

export function Toasts() {
  const { toasts, dismissToast } = useUI();
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`} role={t.kind === 'error' ? 'alert' : undefined}>
          <span>{t.message}</span>
          {t.action && (
            <button
              className="btn small"
              onClick={() => {
                t.action!.run();
                dismissToast(t.id);
              }}
            >
              {t.action.label}
            </button>
          )}
          <button className="icon-btn" aria-label="Dismiss message" onClick={() => dismissToast(t.id)}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

/** Modal built on the native <dialog>: focus trapping and Esc come from the browser. */
export function Dialog({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current!;
    if (!d.open) d.showModal();
    return () => d.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className={`dialog${wide ? ' wide' : ''}`}
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onMouseDown={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      <div className="dialog-body">
        <header className="dialog-head">
          <h2>{title}</h2>
          <button className="icon-btn" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </header>
        {children}
      </div>
    </dialog>
  );
}

/** Re-renders on an interval so "now" based UI (overdue, now-line) stays current. */
export function useNow(intervalMs = 60_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

/** Keeps a crash in one part of the screen from blanking the whole app. */
export class ErrorBoundary extends Component<{ label: string; children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error) {
    console.error(`[${this.props.label}]`, error);
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="card crash" role="alert">
        <h2>{this.props.label} hit a problem</h2>
        <p>This part of the dashboard stopped working. Your data is not affected.</p>
        <p className="muted small">{this.state.error.message}</p>
        <div className="btn-group">
          <button className="btn" onClick={() => this.setState({ error: null })}>Try again</button>
          <button className="btn ghost" onClick={() => window.location.reload()}>Reload the page</button>
        </div>
      </div>
    );
  }
}
