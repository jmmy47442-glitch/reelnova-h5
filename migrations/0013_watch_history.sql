PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS watch_history (
  user_id TEXT NOT NULL,
  series_id TEXT NOT NULL,
  episode_no INTEGER NOT NULL CHECK (episode_no > 0),
  position_seconds INTEGER NOT NULL DEFAULT 0 CHECK (position_seconds >= 0),
  duration_seconds INTEGER NOT NULL DEFAULT 0 CHECK (duration_seconds >= 0),
  completed INTEGER NOT NULL DEFAULT 0 CHECK (completed IN (0, 1)),
  last_event_type TEXT NOT NULL CHECK (last_event_type IN ('start', 'heartbeat', 'complete')),
  last_watched_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(user_id, series_id),
  FOREIGN KEY(user_id) REFERENCES users(user_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_watch_history_user_recent
  ON watch_history(user_id, last_watched_at DESC);

-- Seed account snapshots from the most useful existing event for each title.
-- A zero-value start must not hide an older heartbeat with a real position.
INSERT OR IGNORE INTO watch_history (
  user_id, series_id, episode_no, position_seconds, duration_seconds, completed,
  last_event_type, last_watched_at, created_at, updated_at
)
SELECT
  user_id,
  series_id,
  episode_no,
  CASE
    WHEN event_type = 'complete' AND duration_seconds > 0 THEN duration_seconds
    WHEN duration_seconds > 0 THEN MIN(position_seconds, duration_seconds)
    ELSE position_seconds
  END,
  duration_seconds,
  CASE WHEN event_type = 'complete' THEN 1 ELSE 0 END,
  event_type,
  created_at,
  created_at,
  created_at
FROM (
  SELECT playback_events.*,
    ROW_NUMBER() OVER (
      PARTITION BY user_id, series_id
      ORDER BY
        CASE WHEN position_seconds > 0 OR duration_seconds > 0 OR event_type = 'complete' THEN 1 ELSE 0 END DESC,
        created_at DESC,
        event_id DESC
    ) AS row_no
  FROM playback_events
)
WHERE row_no = 1;
