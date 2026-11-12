-- Assistant action log: every change the assistant proposes, what the user decided,
-- what actually happened, and what is needed to undo it.
CREATE TABLE assistant_actions (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  tool TEXT NOT NULL,
  input TEXT NOT NULL,              -- validated tool input (JSON)
  summary TEXT NOT NULL,            -- human-readable preview title
  details TEXT NOT NULL DEFAULT '[]', -- preview lines (JSON array of strings)
  external INTEGER NOT NULL DEFAULT 0, -- touches Google Calendar
  status TEXT NOT NULL DEFAULT 'proposed'
    CHECK (status IN ('proposed','executed','failed','rejected','undone')),
  result TEXT,                      -- outcome message from the real operation
  undo TEXT,                        -- JSON describing how to reverse it, or NULL
  decided_at TEXT
);
CREATE INDEX assistant_actions_created ON assistant_actions(created_at);
