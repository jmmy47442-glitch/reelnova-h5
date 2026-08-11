PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS user_preferences (
  user_id TEXT PRIMARY KEY,
  language TEXT NOT NULL DEFAULT 'en' CHECK (language IN ('en', 'es', 'pt', 'fr', 'de')),
  recommendations INTEGER NOT NULL DEFAULT 1 CHECK (recommendations IN (0, 1)),
  analytics INTEGER NOT NULL DEFAULT 1 CHECK (analytics IN (0, 1)),
  marketing INTEGER NOT NULL DEFAULT 0 CHECK (marketing IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(user_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS privacy_requests (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  request_type TEXT NOT NULL CHECK (request_type IN ('export', 'deletion')),
  status TEXT NOT NULL CHECK (status IN ('processing', 'completed', 'failed')),
  detail TEXT,
  requested_at TEXT NOT NULL,
  completed_at TEXT,
  FOREIGN KEY(user_id) REFERENCES users(user_id)
);

CREATE INDEX IF NOT EXISTS idx_privacy_requests_user
  ON privacy_requests(user_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_privacy_requests_status
  ON privacy_requests(status, requested_at DESC);
