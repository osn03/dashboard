-- Images (screenshots, photos) attached to assistant messages. Stored with the conversation
-- and removed with it ("Clear conversation" deletes the messages; images cascade).
CREATE TABLE assistant_images (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES assistant_messages(id) ON DELETE CASCADE,
  media_type TEXT NOT NULL CHECK (media_type IN ('image/png','image/jpeg','image/webp','image/gif')),
  data BLOB NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX assistant_images_message ON assistant_images(message_id);
