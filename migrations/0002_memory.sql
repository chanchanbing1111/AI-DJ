ALTER TABLE play_events ADD COLUMN event_type TEXT NOT NULL DEFAULT 'play';
ALTER TABLE play_events ADD COLUMN track_key TEXT;
ALTER TABLE play_events ADD COLUMN reason TEXT;
ALTER TABLE play_events ADD COLUMN duration REAL;
ALTER TABLE play_events ADD COLUMN position REAL;

CREATE INDEX IF NOT EXISTS idx_play_events_track_key ON play_events (track_key);
CREATE INDEX IF NOT EXISTS idx_play_events_type_time ON play_events (event_type, played_at);

CREATE TABLE IF NOT EXISTS user_memory (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS track_memory (
  track_key TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  artist TEXT,
  source TEXT,
  source_id TEXT,
  lyric_summary TEXT,
  dj_notes TEXT,
  emotional_tags TEXT,
  last_intro TEXT,
  play_count INTEGER NOT NULL DEFAULT 0,
  skip_count INTEGER NOT NULL DEFAULT 0,
  completed_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS blocked_phrases (
  phrase TEXT PRIMARY KEY,
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS voice_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
