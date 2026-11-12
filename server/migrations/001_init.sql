CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  json TEXT NOT NULL
);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  area TEXT NOT NULL DEFAULT 'Personal',
  color TEXT NOT NULL DEFAULT '#5b7c99',
  notes TEXT NOT NULL DEFAULT '',
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

-- planned_date / due_date are calendar dates (YYYY-MM-DD), never instants.
-- due_time is an optional wall-clock time (HH:mm) in the configured timezone.
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  series_id TEXT,
  title TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','dismissed')),
  priority INTEGER NOT NULL DEFAULT 0 CHECK (priority BETWEEN 0 AND 3),
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  estimate_min INTEGER,
  planned_date TEXT CHECK (planned_date IS NULL OR planned_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  due_date TEXT CHECK (due_date IS NULL OR due_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  due_time TEXT CHECK (due_time IS NULL OR (due_date IS NOT NULL AND due_time GLOB '[0-2][0-9]:[0-5][0-9]')),
  focus INTEGER NOT NULL DEFAULT 0,
  recurrence TEXT,
  remind_at TEXT,
  reminder_status TEXT NOT NULL DEFAULT 'none' CHECK (reminder_status IN ('none','pending','delivered','failed')),
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX tasks_status ON tasks(status);
CREATE INDEX tasks_planned ON tasks(planned_date);
CREATE INDEX tasks_due ON tasks(due_date);
CREATE INDEX tasks_series ON tasks(series_id);

CREATE TABLE subtasks (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0,
  sort INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX subtasks_task ON subtasks(task_id);

CREATE TABLE task_history (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  at TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX task_history_task ON task_history(task_id);

-- Local calendar items. kind='event' is an appointment; kind='task_block' is a
-- time block linked to exactly one task (the task itself is never duplicated).
CREATE TABLE events (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('event','task_block')),
  task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  all_day INTEGER NOT NULL DEFAULT 0,
  start_date TEXT,
  end_date TEXT,
  start_at TEXT,
  end_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((kind = 'task_block') = (task_id IS NOT NULL)),
  CHECK (kind = 'event' OR all_day = 0),
  CHECK ((all_day = 1 AND start_date IS NOT NULL AND end_date IS NOT NULL AND start_at IS NULL AND end_at IS NULL)
      OR (all_day = 0 AND start_at IS NOT NULL AND end_at IS NOT NULL AND start_date IS NULL AND end_date IS NULL))
);
CREATE INDEX events_start ON events(start_at);
CREATE INDEX events_task ON events(task_id);

CREATE TABLE notes (
  id TEXT PRIMARY KEY,
  body TEXT NOT NULL,
  task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);
