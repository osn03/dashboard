-- Intervals.icu read-only import. Rows are keyed by the source id, so repeated imports
-- update in place. NULL always means "not provided by Intervals.icu", never zero.

CREATE TABLE intervals_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  athlete_id TEXT,
  last_synced_at TEXT,
  last_error TEXT,
  demo INTEGER NOT NULL DEFAULT 0
);

-- Planned workouts and other calendar entries (category WORKOUT, RACE_A, NOTE, ...).
CREATE TABLE intervals_events (
  id TEXT PRIMARY KEY,              -- Intervals.icu event id
  category TEXT NOT NULL,
  start_local TEXT NOT NULL,        -- start_date_local as sent (athlete's local wall time)
  end_local TEXT,
  date TEXT NOT NULL,               -- calendar date part of start_local
  has_time INTEGER NOT NULL,        -- 0 when the time part is 00:00:00 (no real start time)
  type TEXT,                        -- sport, e.g. Ride, Run
  name TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  moving_time_s INTEGER,
  distance_m REAL,
  load INTEGER,                     -- icu_training_load
  indoor INTEGER,
  updated TEXT,
  fetched_at TEXT NOT NULL
);
CREATE INDEX intervals_events_date ON intervals_events(date);

CREATE TABLE intervals_activities (
  id TEXT PRIMARY KEY,              -- Intervals.icu activity id
  start_local TEXT,                 -- start_date_local
  start_utc TEXT,                   -- start_date (UTC instant)
  date TEXT,                        -- calendar date part of start_local
  type TEXT,
  name TEXT NOT NULL DEFAULT '',
  moving_time_s INTEGER,
  elapsed_time_s INTEGER,
  distance_m REAL,
  elevation_m REAL,
  load INTEGER,
  avg_hr INTEGER,
  avg_watts INTEGER,
  calories INTEGER,
  source TEXT,
  paired_event_id TEXT,             -- the planned workout this activity fulfils, if paired
  details_available INTEGER NOT NULL DEFAULT 1,
  fetched_at TEXT NOT NULL
);
CREATE INDEX intervals_activities_date ON intervals_activities(date);

CREATE TABLE intervals_wellness (
  date TEXT PRIMARY KEY,            -- wellness id is the local date
  ctl REAL, atl REAL, ramp_rate REAL,
  resting_hr INTEGER, hrv REAL, hrv_sdnn REAL,
  sleep_secs INTEGER, sleep_score REAL, sleep_quality INTEGER,
  weight REAL, readiness REAL, soreness INTEGER, fatigue INTEGER, stress INTEGER, mood INTEGER,
  updated TEXT,
  fetched_at TEXT NOT NULL
);
