import { z } from 'zod';
import { DATE_RE, TIME_RE, isValidDate, isValidZone } from './dates';

const dateStr = z.string().regex(DATE_RE).refine(isValidDate, 'Invalid calendar date');
const timeStr = z.string().regex(TIME_RE);
const instant = z
  .string()
  .refine((s) => /^\d{4}-\d{2}-\d{2}T/.test(s) && !Number.isNaN(Date.parse(s)), 'Invalid timestamp')
  .transform((s) => new Date(s).toISOString());
const id = z.string().min(1).max(64);

export const recurrenceSchema = z.object({
  freq: z.enum(['daily', 'weekly', 'monthly', 'yearly']),
  interval: z.number().int().min(1).max(365).default(1),
  /** ISO weekdays (1=Mon..7=Sun); weekly only. */
  weekdays: z.array(z.number().int().min(1).max(7)).max(7).optional(),
  /** Day of month the series is anchored to (prevents 31 -> 28 -> 28 drift). */
  dayOfMonth: z.number().int().min(1).max(31).optional(),
});
export type Recurrence = z.infer<typeof recurrenceSchema>;

export const taskStatus = z.enum(['open', 'done', 'dismissed']);
export type TaskStatus = z.infer<typeof taskStatus>;

const taskFields = {
  title: z.string().trim().min(1).max(300),
  notes: z.string().max(20000),
  priority: z.number().int().min(0).max(3),
  projectId: id.nullable(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20),
  estimateMin: z.number().int().min(1).max(24 * 60).nullable(),
  plannedDate: dateStr.nullable(),
  dueDate: dateStr.nullable(),
  dueTime: timeStr.nullable(),
  focus: z.boolean(),
  recurrence: recurrenceSchema.nullable(),
  remindAt: instant.nullable(),
};

export const taskCreateSchema = z
  .object({
    title: taskFields.title,
    notes: taskFields.notes.default(''),
    priority: taskFields.priority.default(0),
    projectId: taskFields.projectId.default(null),
    tags: taskFields.tags.default([]),
    estimateMin: taskFields.estimateMin.default(null),
    plannedDate: taskFields.plannedDate.default(null),
    dueDate: taskFields.dueDate.default(null),
    dueTime: taskFields.dueTime.default(null),
    focus: taskFields.focus.default(false),
    recurrence: taskFields.recurrence.default(null),
    remindAt: taskFields.remindAt.default(null),
    subtasks: z.array(z.string().trim().min(1).max(300)).max(50).default([]),
  })
  .strict();
export type TaskCreate = z.input<typeof taskCreateSchema>;

export const taskPatchSchema = z.object(taskFields).partial().strict();
export type TaskPatch = z.infer<typeof taskPatchSchema>;

export const subtaskCreateSchema = z.object({ title: z.string().trim().min(1).max(300) }).strict();
export const subtaskPatchSchema = z
  .object({ title: z.string().trim().min(1).max(300), done: z.boolean() })
  .partial()
  .strict();

export const projectCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    area: z.string().trim().min(1).max(40).default('Personal'),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#5b7c99'),
    notes: z.string().max(20000).default(''),
  })
  .strict();
export const projectPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    area: z.string().trim().min(1).max(40),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    notes: z.string().max(20000),
    archived: z.boolean(),
  })
  .partial()
  .strict();

const eventBase = {
  title: z.string().trim().min(1).max(300),
  notes: z.string().max(20000).default(''),
  location: z.string().max(300).default(''),
};
export const eventCreateSchema = z.discriminatedUnion('allDay', [
  z
    .object({ ...eventBase, allDay: z.literal(true), startDate: dateStr, endDate: dateStr })
    .strict()
    .refine((e) => e.endDate >= e.startDate, 'End date is before start date'),
  z
    .object({ ...eventBase, allDay: z.literal(false), startAt: instant, endAt: instant })
    .strict()
    .refine((e) => e.endAt > e.startAt, 'End must be after start'),
]);
export type EventCreate = z.input<typeof eventCreateSchema>;

export const eventPatchSchema = z
  .object({
    title: z.string().trim().min(1).max(300),
    notes: z.string().max(20000),
    location: z.string().max(300),
    startDate: dateStr,
    endDate: dateStr,
    startAt: instant,
    endAt: instant,
  })
  .partial()
  .strict();

const googleBase = {
  calendarId: z.string().min(1).max(300),
  /** Client-generated event id (base32hex subset). Reusing it on retry makes creation idempotent. */
  clientId: z.string().regex(/^[a-v0-9]{5,64}$/),
  /**
   * 'default' = the calendar's own standard reminders (as set in Google Calendar);
   * otherwise notification times in minutes before the start. An empty list means none.
   */
  reminders: z.union([z.literal('default'), z.array(z.number().int().min(0).max(40320)).max(5)]).default('default'),
  ...eventBase,
};
export const googleEventCreateSchema = z.discriminatedUnion('allDay', [
  z
    .object({ ...googleBase, allDay: z.literal(true), startDate: dateStr, endDate: dateStr })
    .strict()
    .refine((e) => e.endDate >= e.startDate, 'End date is before start date'),
  z
    .object({ ...googleBase, allDay: z.literal(false), startAt: instant, endAt: instant })
    .strict()
    .refine((e) => e.endAt > e.startAt, 'End must be after start'),
]);
export type GoogleEventCreate = z.output<typeof googleEventCreateSchema>;

export const googleEventPatchSchema = z
  .object({
    /** For recurring events: change only this occurrence, or the whole series. */
    scope: z.enum(['occurrence', 'series']).default('occurrence'),
    /** ETag the user was looking at; Google rejects the write if the event changed since. */
    etag: z.string().max(300).nullable().default(null),
    title: z.string().trim().min(1).max(300).optional(),
    notes: z.string().max(20000).optional(),
    location: z.string().max(300).optional(),
    startDate: dateStr.optional(),
    endDate: dateStr.optional(),
    startAt: instant.optional(),
    endAt: instant.optional(),
  })
  .strict();
export type GoogleEventPatch = z.output<typeof googleEventPatchSchema>;

export const googleCalendarsSchema = z
  .object({
    selected: z.array(z.string().max(300)).max(300),
    defaultCalendarId: z.string().max(300).nullable(),
    /** Calendar that receives copies of task time blocks; null turns mirroring off. */
    mirrorCalendarId: z.string().max(300).nullable().optional(),
    /** Per-calendar colour overrides; null restores Google's colour. */
    colors: z.record(z.string().max(300), z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable()).optional(),
  })
  .strict();

export const scheduleTaskSchema = z
  .object({ startAt: instant, endAt: instant })
  .strict()
  .refine((e) => e.endAt > e.startAt, 'End must be after start');

export const noteCreateSchema = z
  .object({
    body: z.string().trim().min(1).max(20000),
    taskId: id.nullable().default(null),
    projectId: id.nullable().default(null),
  })
  .strict();

export const settingsSchema = z.object({
  timezone: z.string().refine(isValidZone, 'Unknown timezone').default('Europe/Oslo'),
  weekStart: z.number().int().min(1).max(7).default(1),
  hour12: z.boolean().default(false),
  theme: z.enum(['system', 'light', 'dark']).default('system'),
  workStart: timeStr.default('08:00'),
  workEnd: timeStr.default('16:00'),
  /** ISO weekdays that count as working days. */
  workDays: z.array(z.number().int().min(1).max(7)).default([1, 2, 3, 4, 5]),
  defaultBlockMin: z.number().int().min(5).max(480).default(60),
  dayStartHour: z.number().int().min(0).max(12).default(6),
  /** Whether the assistant may read training and wellness data. Off unless you switch it on. */
  aiIncludeTraining: z.boolean().default(false),
  /** Which assistant to use when both are set up. */
  aiProvider: z.enum(['claude_code', 'anthropic', 'openai']).default('claude_code'),
  /** Model for the Claude Code (subscription) assistant: an alias such as sonnet, or a full model id. */
  claudeCodeModel: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._\-\[\]]{0,59}$/).default('sonnet'),
  /** Off: the subscription assistant stops when requests would be charged to paid extra usage (usage credits). */
  claudeCodeAllowExtraUsage: z.boolean().default(false),
});
export type Settings = z.infer<typeof settingsSchema>;
export const DEFAULT_SETTINGS: Settings = settingsSchema.parse({});

export const credentialsSchema = z
  .object({ username: z.string().trim().min(1).max(60), password: z.string().min(10).max(200) })
  .strict();

// ---- Entities returned by the API ----
export interface Subtask {
  id: string;
  taskId: string;
  title: string;
  done: boolean;
  sort: number;
}
export interface Task {
  id: string;
  seriesId: string | null;
  title: string;
  notes: string;
  status: TaskStatus;
  priority: number;
  projectId: string | null;
  tags: string[];
  estimateMin: number | null;
  plannedDate: string | null;
  dueDate: string | null;
  dueTime: string | null;
  focus: boolean;
  recurrence: Recurrence | null;
  remindAt: string | null;
  reminderStatus: 'none' | 'pending' | 'delivered' | 'failed';
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  subtasks: Subtask[];
}
export interface Project {
  id: string;
  name: string;
  area: string;
  color: string;
  notes: string;
  archived: boolean;
}
export interface CalEvent {
  id: string;
  kind: 'event' | 'task_block' | 'training';
  taskId: string | null;
  title: string;
  notes: string;
  location: string;
  allDay: boolean;
  startDate: string | null;
  endDate: string | null;
  startAt: string | null;
  endAt: string | null;
  source: 'app' | 'google' | 'intervals';
  updatedAt: string;
  /** Present only for events that live in Google Calendar. */
  google?: GoogleEventInfo;
  /** Present on task time blocks when mirroring to Google is on (or left a copy behind). */
  mirror?: MirrorInfo;
  training?: TrainingInfo;
}
export interface GoogleEventInfo {
  /** The app's key for the calendar (google_calendars.id), not necessarily Google's id. */
  calendarId: string;
  eventId: string;
  calendarName: string;
  accountLabel: string | null;
  color: string | null;
  readOnly: boolean;
  recurringEventId: string | null;
  htmlLink: string | null;
  etag: string | null;
  hasGuests: boolean;
  /** When this copy was last fetched from Google. */
  fetchedAt: string;
}
/** State of the optional Google copy of a task time block. */
export interface MirrorInfo {
  state: 'synced' | 'pending' | 'failed';
  calendarName: string | null;
  error: string | null;
}
/** Present on items imported from Intervals.icu (read-only). null = not provided by the source. */
export interface TrainingInfo {
  sourceId: string;
  what: 'planned' | 'completed';
  sport: string | null;
  durationMin: number | null;
  distanceKm: number | null;
  load: number | null;
  /** Planned workout that has a paired completed activity. */
  done: boolean;
}
export interface GoogleAccountInfo {
  id: string;
  label: string | null;
  status: 'connected' | 'revoked' | 'demo';
  lastError: string | null;
}
export interface GoogleCalendarInfo {
  id: string;
  accountId: string;
  accountLabel: string | null;
  summary: string;
  /** Colour used in this app: your override, else Google's, else an assigned one. */
  color: string;
  colorOverridden: boolean;
  accessRole: string;
  readOnly: boolean;
  primary: boolean;
  selected: boolean;
  isDefault: boolean;
  isMirror: boolean;
  lastSyncedAt: string | null;
  lastError: string | null;
}
export interface GoogleStatus {
  /** not_configured: no OAuth client in .env; disconnected: no account yet. */
  state: 'not_configured' | 'disconnected' | 'connected';
  /** False when the OAuth client is missing (existing accounts cannot sync or be added). */
  canConnect: boolean;
  accounts: GoogleAccountInfo[];
  calendars: GoogleCalendarInfo[];
  defaultCalendarId: string | null;
  mirrorCalendarId: string | null;
  mirrorPending: number;
  syncing: boolean;
  hidden: { calendarId: string; eventKey: string; title: string }[];
}
export interface Note {
  id: string;
  body: string;
  taskId: string | null;
  projectId: string | null;
  createdAt: string;
}
export interface HistoryEntry {
  id: string;
  taskId: string;
  type: string;
  at: string;
  data: Record<string, unknown>;
}

export const PRIORITY_LABELS = ['None', 'Low', 'Medium', 'High'] as const;
export const LIFE_AREAS = ['Work', 'Personal', 'Health', 'Admin'] as const;

// ---- Training (Intervals.icu, read-only). null always means "not provided", never zero. ----
export interface TrainingItem {
  /** Id at Intervals.icu (event id for planned, activity id for completed). */
  id: string;
  what: 'planned' | 'completed';
  date: string;
  /** Local wall time HH:mm, or null when the source has no real start time. */
  time: string | null;
  startAt: string | null;
  name: string;
  sport: string | null;
  category: string | null;
  durationMin: number | null;
  distanceKm: number | null;
  load: number | null;
  avgHr: number | null;
  /** planned: a completed activity is paired with it. completed: always true. */
  done: boolean;
  pairedEventId: string | null;
  /** false when the source (e.g. Strava) does not expose details through the API. */
  detailsAvailable: boolean;
  source: string | null;
}
export interface Sum {
  value: number | null;
  /** Number of items that had no value and are therefore not in the sum. */
  missing: number;
}
export interface TrainingTotals {
  count: number;
  durationMin: Sum;
  distanceKm: Sum;
  load: Sum;
}
export interface WellnessDay {
  date: string;
  ctl: number | null;
  atl: number | null;
  form: number | null;
  rampRate: number | null;
  restingHr: number | null;
  hrv: number | null;
  sleepHours: number | null;
  sleepScore: number | null;
  weight: number | null;
  readiness: number | null;
}
export interface TrainingStatus {
  state: 'not_configured' | 'never_synced' | 'ok' | 'error' | 'demo';
  athleteId: string | null;
  lastSyncedAt: string | null;
  lastError: string | null;
  syncing: boolean;
  counts: { planned: number; activities: number; wellnessDays: number };
}
export interface TrainingSummary {
  status: TrainingStatus;
  today: string;
  todayPlanned: TrainingItem[];
  todayCompleted: TrainingItem[];
  upcoming: TrainingItem[];
  recent: TrainingItem[];
  week: {
    start: string;
    end: string;
    planned: TrainingItem[];
    completed: TrainingItem[];
    plannedTotals: TrainingTotals;
    completedTotals: TrainingTotals;
    plannedDone: number;
  };
  wellness: WellnessDay[];
}

// ---- Assistant ----
export type AiProvider = 'claude_code' | 'anthropic' | 'openai';
/** What `claude --version` and `claude auth status` report. Contains no credentials. */
export interface ClaudeCodeStatus {
  state: 'ready' | 'not_installed' | 'signed_out' | 'conflict' | 'error';
  path: string | null;
  version: string | null;
  /** As reported by Claude Code, e.g. "claude.ai" for a subscription sign-in. */
  authMethod: string | null;
  plan: string | null;
  loginExpiresAt: string | null;
  message: string;
  /** Names of API-billing settings found in the dashboard's environment and NOT passed to Claude Code. */
  withheld: string[];
  checkedAt: string;
}
export interface AssistantStatus {
  /** State of the provider selected in Settings. There is no automatic fallback to another provider. */
  state: 'not_configured' | 'ready' | 'demo';
  provider: AiProvider;
  providerName: string;
  model: string;
  /** How usage of the selected provider is paid for. */
  billing: 'subscription' | 'api';
  /** Why the selected provider cannot be used right now, if it cannot. */
  message: string | null;
  providers: { id: AiProvider; name: string; model: string; configured: boolean; billing: 'subscription' | 'api' }[];
  claudeCode: ClaudeCodeStatus | null;
  claudeCodeModels: { id: string; label: string; note: string; extraUsage: boolean }[];
  /** Set when Claude last reported that the plan limit is used up; ISO time when it resets. */
  planLimitResetsAt: string | null;
  /** True when this request did not come from this computer; the subscription assistant is then refused. */
  remoteBlocked: boolean;
  includeTraining: boolean;
}
export interface ChatMessage {
  id: string;
  createdAt: string;
  role: 'user' | 'assistant';
  text: string;
  provider: AiProvider | null;
  model: string | null;
  proposalIds: string[];
  /** Images attached to this message; fetch with GET /api/assistant/images/:id. */
  imageIds: string[];
  /** An error notice from the dashboard, not model output. */
  error: boolean;
}
export interface AssistantAction {
  id: string;
  createdAt: string;
  tool: string;
  /** Preview shown before confirmation. */
  summary: string;
  details: string[];
  /** True when confirming it writes to Google Calendar. */
  external: boolean;
  status: 'proposed' | 'executed' | 'failed' | 'rejected' | 'undone';
  /** Outcome reported by the real operation after confirmation. */
  result: string | null;
  canUndo: boolean;
  decidedAt: string | null;
  /** Fingerprint of the exact operation previewed; must be sent back to confirm it. */
  digest: string | null;
}
export const assistantChatSchema = z
  .object({
    messages: z
      .array(z.object({ role: z.enum(['user', 'assistant']), text: z.string().min(1).max(8000) }).strict())
      .min(1)
      .max(40)
      .refine((m) => m[m.length - 1].role === 'user', 'The last message must be from the user'),
  })
  .strict();
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;
export const MAX_CHAT_IMAGES = 4;
/** Largest accepted image after decoding (bytes). The browser shrinks screenshots before sending. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const chatImageSchema = z
  .object({ mediaType: z.enum(IMAGE_TYPES), data: z.string().min(16).max(Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 8).regex(/^[A-Za-z0-9+/]+={0,2}$/, 'not base64') })
  .strict();
export type ChatImage = z.infer<typeof chatImageSchema>;
export const assistantSendSchema = z
  .object({ text: z.string().trim().max(8000).default(''), images: z.array(chatImageSchema).max(MAX_CHAT_IMAGES).default([]) })
  .strict()
  .refine((v) => v.text.length > 0 || v.images.length > 0, 'Write a message or attach an image');
export const assistantConfirmSchema = z.object({ digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
