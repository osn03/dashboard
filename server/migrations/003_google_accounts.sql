-- Multiple Google accounts. The existing single connection (if any) is carried over
-- unchanged as account 'primary': same encrypted token, same calendars, same selection.

CREATE TABLE google_accounts (
  id TEXT PRIMARY KEY,
  label TEXT,                       -- primary calendar id (normally the account e-mail)
  refresh_token_enc TEXT NOT NULL,  -- AES-256-GCM, key from APP_ENCRYPTION_KEY
  scopes TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'connected' CHECK (status IN ('connected','revoked','demo')),
  last_error TEXT,
  connected_at TEXT NOT NULL
);

INSERT INTO google_accounts (id, label, refresh_token_enc, scopes, status, last_error, connected_at)
  SELECT 'primary', label, refresh_token_enc, scopes, status, last_error, connected_at FROM google_account;

-- google_calendars.id stays the app's own key for a calendar (existing rows keep theirs, so
-- cached events and links stay valid). google_id is the id at Google, unique per account:
-- the same shared calendar reached through two accounts is two separate rows, each with its
-- own sync token and its own event cache, so nothing is merged or duplicated by accident.
ALTER TABLE google_calendars ADD COLUMN account_id TEXT REFERENCES google_accounts(id) ON DELETE CASCADE;
ALTER TABLE google_calendars ADD COLUMN google_id TEXT;
ALTER TABLE google_calendars ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0;
ALTER TABLE google_calendars ADD COLUMN color_override TEXT;

UPDATE google_calendars
   SET account_id = 'primary',
       google_id = id,
       is_default = COALESCE(id = (SELECT default_calendar_id FROM google_account), 0);

DROP TABLE google_account;
CREATE UNIQUE INDEX google_calendars_account ON google_calendars(account_id, google_id);

-- Google events the user chose not to show here (e.g. a duplicate of an Intervals.icu workout).
-- event_key is the recurring series id when there is one, otherwise the event id.
CREATE TABLE google_hidden (
  calendar_id TEXT NOT NULL,
  event_key TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  hidden_at TEXT NOT NULL,
  PRIMARY KEY (calendar_id, event_key)
);
