-- Assistant chat history (text only; never credentials) and confirmation binding.

CREATE TABLE assistant_messages (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user','assistant')),
  text TEXT NOT NULL,
  provider TEXT,                         -- which assistant answered (assistant rows)
  model TEXT,
  proposal_ids TEXT NOT NULL DEFAULT '[]', -- assistant_actions proposed in this reply
  error INTEGER NOT NULL DEFAULT 0         -- 1 = this row is an error notice, not model output
);
CREATE INDEX assistant_messages_created ON assistant_messages(created_at);

-- Fingerprint of exactly what was previewed (tool + validated input). Confirmation must
-- present the same fingerprint, and execution re-checks it against the stored input.
ALTER TABLE assistant_actions ADD COLUMN digest TEXT;

-- The assistant now runs on the locally installed Claude Code (subscription sign-in) unless
-- another provider is chosen explicitly in Settings.
UPDATE settings SET json = json_set(json, '$.aiProvider', 'claude_code') WHERE id = 1;
