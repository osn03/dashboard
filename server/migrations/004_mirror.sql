-- Optional mirroring of task time blocks into one Google calendar.
-- The app stays the source of truth for blocks; the Google copy is derived.

ALTER TABLE google_calendars ADD COLUMN is_mirror INTEGER NOT NULL DEFAULT 0;

ALTER TABLE events ADD COLUMN mirror_calendar_id TEXT;  -- google_calendars.id holding the copy
ALTER TABLE events ADD COLUMN mirror_event_id TEXT;     -- event id at Google (derived from the block id)
ALTER TABLE events ADD COLUMN mirror_hash TEXT;         -- what was last pushed
ALTER TABLE events ADD COLUMN mirror_error TEXT;

-- Copies that must be removed at Google because their block is gone (including blocks
-- removed by deleting their task, which cascades).
CREATE TABLE mirror_deletes (
  calendar_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (calendar_id, event_id)
);

CREATE TRIGGER events_mirror_delete AFTER DELETE ON events
WHEN old.mirror_event_id IS NOT NULL
BEGIN
  INSERT OR IGNORE INTO mirror_deletes (calendar_id, event_id, created_at)
  VALUES (old.mirror_calendar_id, old.mirror_event_id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;
