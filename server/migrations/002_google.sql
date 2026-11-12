-- Google Calendar integration. Google is the source of truth for these rows;
-- google_events is a cache that is rebuilt from Google on full sync.

CREATE TABLE google_account (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  label TEXT,                       -- primary calendar id (normally the account e-mail)
  refresh_token_enc TEXT NOT NULL,  -- AES-256-GCM, key from APP_ENCRYPTION_KEY
  scopes TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'connected' CHECK (status IN ('connected','revoked')),
  default_calendar_id TEXT,
  last_error TEXT,
  connected_at TEXT NOT NULL
);

CREATE TABLE google_calendars (
  id TEXT PRIMARY KEY,
  summary TEXT NOT NULL,
  color TEXT,
  access_role TEXT NOT NULL,
  is_primary INTEGER NOT NULL DEFAULT 0,
  time_zone TEXT,
  selected INTEGER NOT NULL DEFAULT 0,
  sync_token TEXT,
  last_synced_at TEXT,
  last_error TEXT
);

CREATE TABLE google_events (
  calendar_id TEXT NOT NULL REFERENCES google_calendars(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  etag TEXT,
  summary TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  html_link TEXT,
  all_day INTEGER NOT NULL,
  start_date TEXT,   -- all-day: first day
  end_date TEXT,     -- all-day: last day, inclusive (Google's end.date is exclusive)
  start_at TEXT,     -- timed: UTC instant
  end_at TEXT,
  recurring_event_id TEXT,
  event_type TEXT,
  can_edit INTEGER NOT NULL DEFAULT 0,
  has_guests INTEGER NOT NULL DEFAULT 0,
  updated TEXT,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (calendar_id, id)
);
CREATE INDEX google_events_start ON google_events(start_at);
CREATE INDEX google_events_date ON google_events(start_date);
