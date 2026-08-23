PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS analytics_events (
  event_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  user_id TEXT,
  event_name TEXT NOT NULL CHECK (length(event_name) <= 64),
  page_path TEXT,
  series_id TEXT,
  series_title TEXT,
  episode_no INTEGER CHECK (episode_no IS NULL OR episode_no > 0),
  position_seconds INTEGER NOT NULL DEFAULT 0 CHECK (position_seconds >= 0),
  duration_seconds INTEGER NOT NULL DEFAULT 0 CHECK (duration_seconds >= 0),
  properties_json TEXT NOT NULL DEFAULT '{}',
  country TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_analytics_events_name_created
  ON analytics_events(event_name, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_analytics_events_series_created
  ON analytics_events(series_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_analytics_events_session_created
  ON analytics_events(session_id, created_at DESC);
