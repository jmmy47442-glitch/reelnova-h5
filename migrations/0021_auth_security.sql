PRAGMA foreign_keys = ON;

-- Short-lived, single-use authentication challenges. The signed token is
-- still verified cryptographically; this table prevents replay.
CREATE TABLE IF NOT EXISTS auth_challenges (
  nonce TEXT PRIMARY KEY,
  email TEXT NOT NULL COLLATE NOCASE,
  purpose TEXT NOT NULL CHECK (purpose IN ('login', 'reset')),
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_auth_challenges_expiry
  ON auth_challenges(expires_at, consumed_at);

-- Durable fixed-window counters shared by all application instances.
CREATE TABLE IF NOT EXISTS auth_rate_limits (
  bucket_key TEXT PRIMARY KEY,
  window_started_at INTEGER NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0 CHECK (request_count >= 0),
  blocked_until INTEGER,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_auth_rate_limits_updated
  ON auth_rate_limits(updated_at);
