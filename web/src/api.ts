import { useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AssistantAction, AssistantStatus, CalEvent, ChatMessage, EventCreate, GoogleStatus, HistoryEntry, Note, Project, Settings, Task, TaskCreate, TaskPatch, TrainingSummary,
} from '../../shared/types';
import { useUI } from './ui';

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'dashboard' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'Cannot reach the server. Nothing was saved - check that the app is running and try again.');
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/api/auth/')) window.dispatchEvent(new Event('auth-expired'));
    throw new ApiError(res.status, data?.error ?? `Request failed (${res.status})`);
  }
  return data as T;
}

export interface Me {
  user: { username: string } | null;
  needsSetup: boolean;
  /** Sample data in a separate database. */
  demo: boolean;
}

export const useMe = () => useQuery({ queryKey: ['me'], queryFn: () => api<Me>('GET', '/api/auth/me'), retry: 1 });
export const useSettings = () => useQuery({ queryKey: ['settings'], queryFn: () => api<Settings>('GET', '/api/settings') });
export const useTasks = () => useQuery({ queryKey: ['tasks'], queryFn: () => api<Task[]>('GET', '/api/tasks') });
export const useProjects = () => useQuery({ queryKey: ['projects'], queryFn: () => api<Project[]>('GET', '/api/projects') });
export const useNotes = () => useQuery({ queryKey: ['notes'], queryFn: () => api<Note[]>('GET', '/api/notes') });
export const useEvents = (from: string, to: string) =>
  useQuery({
    queryKey: ['events', from, to],
    queryFn: () => api<CalEvent[]>('GET', `/api/events?from=${from}&to=${to}`),
    placeholderData: (prev) => prev,
    refetchInterval: 60_000, // picks up background Google syncs
  });
export const useGoogle = () =>
  useQuery({ queryKey: ['google'], queryFn: () => api<GoogleStatus>('GET', '/api/google/status'), refetchInterval: 60_000 });
export const useTraining = (weekOf?: string) =>
  useQuery({
    queryKey: ['training', weekOf ?? 'current'],
    queryFn: () => api<TrainingSummary>('GET', `/api/training/summary${weekOf ? `?weekOf=${weekOf}` : ''}`),
    refetchInterval: 5 * 60_000,
    placeholderData: (prev) => prev,
  });
export const useAssistantStatus = () => useQuery({ queryKey: ['assistant', 'status'], queryFn: () => api<AssistantStatus>('GET', '/api/assistant/status') });
export const useAssistantHistory = () => useQuery({ queryKey: ['assistant', 'history'], queryFn: () => api<ChatMessage[]>('GET', '/api/assistant/history') });
export const useAssistantActions = (enabled: boolean) =>
  useQuery({ queryKey: ['assistant', 'actions'], queryFn: () => api<AssistantAction[]>('GET', '/api/assistant/actions'), enabled });
export const useTaskBlocks = (taskId: string | null) =>
  useQuery({
    queryKey: ['events', 'task', taskId],
    queryFn: () => api<CalEvent[]>('GET', `/api/tasks/${taskId}/blocks`),
    enabled: !!taskId,
  });
export const useTaskHistory = (taskId: string | null, enabled: boolean) =>
  useQuery({
    queryKey: ['tasks', 'history', taskId],
    queryFn: () => api<HistoryEntry[]>('GET', `/api/tasks/${taskId}/history`),
    enabled: !!taskId && enabled,
  });

/**
 * Mutations. Nothing is shown as saved until the server has confirmed it:
 * on success the affected queries are refetched, on failure an error toast appears.
 */
export function useActions() {
  const qc = useQueryClient();
  const { toast } = useUI();

  async function run<T>(fn: () => Promise<T>, keys: string[], ok?: string | ((r: T) => void)): Promise<T | undefined> {
    try {
      const r = await fn();
      await Promise.all(keys.map((k) => qc.invalidateQueries({ queryKey: [k] })));
      if (typeof ok === 'string') toast(ok);
      else ok?.(r);
      return r;
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Something went wrong', { kind: 'error' });
      // Refetch anyway: after a conflict the server holds a newer version than the screen.
      void Promise.all(keys.map((k) => qc.invalidateQueries({ queryKey: [k] })));
      return undefined;
    }
  }
  const gpath = (e: CalEvent) => `/api/google/events/${encodeURIComponent(e.google!.calendarId)}/${encodeURIComponent(e.google!.eventId)}`;
  const T = ['tasks'];
  const TE = ['tasks', 'events'];

  const actions = {
    createTask: (t: TaskCreate, msg = 'Task added') => run(() => api<Task>('POST', '/api/tasks', t), T, msg),
    patchTask: (id: string, p: TaskPatch, msg?: string) => run(() => api<Task>('PATCH', `/api/tasks/${id}`, p), TE, msg),
    completeTask: (id: string) =>
      run(() => api<{ task: Task; next: Task | null }>('POST', `/api/tasks/${id}/complete`), TE, (r) =>
        toast(r.next ? 'Completed. Next occurrence created.' : 'Task completed', {
          action: r.next ? undefined : { label: 'Undo', run: () => void actions.reopenTask(id) },
        }),
      ),
    dismissTask: (id: string) =>
      run(() => api('POST', `/api/tasks/${id}/dismiss`), TE, () =>
        toast('Task dismissed', { action: { label: 'Undo', run: () => void actions.reopenTask(id) } }),
      ),
    reopenTask: (id: string) => run(() => api<Task>('POST', `/api/tasks/${id}/reopen`), TE),
    deleteTask: (id: string) => run(() => api('DELETE', `/api/tasks/${id}`), TE, 'Task deleted'),
    scheduleTask: (id: string, startAt: string, endAt: string) =>
      run(() => api<CalEvent>('POST', `/api/tasks/${id}/schedule`, { startAt, endAt }), TE, 'Time block added'),
    addSubtask: (taskId: string, title: string) => run(() => api<Task>('POST', `/api/tasks/${taskId}/subtasks`, { title }), T),
    patchSubtask: (id: string, p: { title?: string; done?: boolean }) => run(() => api<Task>('PATCH', `/api/subtasks/${id}`, p), T),
    deleteSubtask: (id: string) => run(() => api<Task>('DELETE', `/api/subtasks/${id}`), T),
    createEvent: (e: EventCreate) => run(() => api<CalEvent>('POST', '/api/events', e), ['events'], 'Event added'),
    patchEvent: (id: string, p: Record<string, unknown>, msg?: string) =>
      run(() => api<CalEvent>('PATCH', `/api/events/${id}`, p), TE, msg),
    deleteEvent: (id: string, msg = 'Event deleted') => run(() => api('DELETE', `/api/events/${id}`), TE, msg),
    // ----- Google Calendar (nothing is shown as saved until Google has confirmed it) -----
    createGoogleEvent: (e: Record<string, unknown>) =>
      run(() => api<CalEvent>('POST', '/api/google/events', e), ['events'], 'Event added to Google Calendar'),
    patchGoogleEvent: (ev: CalEvent, p: Record<string, unknown>, msg = 'Saved to Google Calendar') =>
      run(() => api<CalEvent>('PATCH', gpath(ev), { ...p, etag: ev.google!.etag }), ['events'], msg),
    deleteGoogleEvent: (ev: CalEvent, scope: 'occurrence' | 'series') =>
      run(
        () => api('DELETE', `${gpath(ev)}?scope=${scope}&etag=${encodeURIComponent(ev.google!.etag ?? '')}`),
        ['events'],
        'Deleted from Google Calendar',
      ),
    /** Move/resize from the calendar grid, for local and Google items alike. */
    moveEvent: (ev: CalEvent, times: { startAt?: string; endAt?: string }): Promise<unknown> =>
      ev.source === 'google'
        ? actions.patchGoogleEvent(ev, { scope: 'occurrence', ...times }, ev.google!.recurringEventId ? 'Changed this occurrence only' : 'Saved to Google Calendar')
        : actions.patchEvent(ev.id, times, ev.kind === 'task_block' ? 'Time block updated' : 'Event updated'),
    googleConnect: async () => {
      try {
        const r = await api<{ url: string }>('POST', '/api/google/connect', { returnTo: window.location.origin });
        window.location.assign(r.url);
      } catch (e) {
        toast(e instanceof Error ? e.message : 'Could not start Google sign-in', { kind: 'error' });
      }
    },
    googleDisconnect: (accountId: string) =>
      run(() => api('POST', `/api/google/accounts/${encodeURIComponent(accountId)}/disconnect`), ['google', 'events'], 'Google account disconnected'),
    googleSetCalendars: (p: { selected: string[]; defaultCalendarId: string | null; mirrorCalendarId: string | null; colors: Record<string, string | null> }) =>
      run(() => api<GoogleStatus>('PUT', '/api/google/calendars', p), ['google', 'events'], 'Calendar settings saved'),
    hideGoogleEvent: (ev: CalEvent) =>
      run(() => api('POST', `${gpath(ev)}/hide`), ['google', 'events'], 'Hidden in this dashboard. Nothing was changed in Google. Undo in Settings.'),
    unhideGoogleEvent: (calendarId: string, eventKey: string) => run(() => api('POST', '/api/google/unhide', { calendarId, eventKey }), ['google', 'events']),
    trainingSync: () =>
      run(
        async () => {
          const r = await api<{ ok: boolean; error: string | null }>('POST', '/api/training/sync');
          if (!r.ok) throw new Error(r.error ?? 'Import failed');
          return r;
        },
        ['training', 'events'],
        'Training data imported',
      ),
    // Confirming sends back the fingerprint of the operation that was previewed.
    assistantDecide: (id: string, what: 'confirm' | 'reject' | 'undo', digest: string | null) =>
      run(() => api<AssistantAction>('POST', `/api/assistant/actions/${id}/${what}`, what === 'confirm' ? { digest } : undefined), ['assistant', 'tasks', 'events', 'google']),
    googleSync: () =>
      run(
        async () => {
          const r = await api<{ ok: boolean; error: string | null }>('POST', '/api/google/sync');
          if (!r.ok) throw new Error(r.error ?? 'Sync failed');
          return r;
        },
        ['google', 'events'],
        'Google Calendar is up to date',
      ),
    createNote: (body: string, taskId: string | null = null, projectId: string | null = null) =>
      run(() => api<Note>('POST', '/api/notes', { body, taskId, projectId }), ['notes'], taskId || projectId ? undefined : 'Note saved'),
    deleteNote: (id: string) => run(() => api('DELETE', `/api/notes/${id}`), ['notes']),
    createProject: (p: { name: string; area: string; color?: string }) =>
      run(() => api<Project>('POST', '/api/projects', p), ['projects'], 'Project added'),
    patchProject: (id: string, p: Partial<Project>) => run(() => api<Project>('PATCH', `/api/projects/${id}`, p), ['projects']),
    deleteProject: (id: string) => run(() => api('DELETE', `/api/projects/${id}`), ['projects', 'tasks'], 'Project deleted'),
    saveSettings: (s: Settings) => run(() => api<Settings>('PUT', '/api/settings', s), ['settings', 'events', 'training', 'assistant'], 'Settings saved'),
  };
  return actions;
}
