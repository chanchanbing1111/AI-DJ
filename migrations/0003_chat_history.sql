CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  kind TEXT NOT NULL DEFAULT 'chat',
  content TEXT NOT NULL,
  track_key TEXT,
  track_title TEXT,
  track_artist TEXT,
  track_source TEXT,
  track_source_id TEXT,
  metadata TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_time ON chat_messages (created_at);
CREATE INDEX IF NOT EXISTS idx_chat_messages_kind_time ON chat_messages (kind, created_at);
CREATE INDEX IF NOT EXISTS idx_chat_messages_track_key ON chat_messages (track_key);
