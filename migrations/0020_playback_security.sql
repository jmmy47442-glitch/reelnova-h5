PRAGMA foreign_keys = ON;

-- A playback session is the server-side identity behind every short-lived
-- Stream token. Device and network identifiers are HMAC digests; raw values
-- are never persisted.
CREATE TABLE IF NOT EXISTS playback_sessions (
  session_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  series_id TEXT NOT NULL,
  episode_no INTEGER NOT NULL CHECK (episode_no > 0),
  device_hash TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  user_agent_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked', 'expired', 'blocked')),
  blocked_reason TEXT,
  token_count INTEGER NOT NULL DEFAULT 0 CHECK (token_count >= 0),
  event_count INTEGER NOT NULL DEFAULT 0 CHECK (event_count >= 0),
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_token_at TEXT,
  revoked_at TEXT,
  FOREIGN KEY(user_id) REFERENCES users(user_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_playback_sessions_user_active
  ON playback_sessions(user_id, status, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_playback_sessions_device_active
  ON playback_sessions(device_hash, status, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_playback_sessions_expiry
  ON playback_sessions(status, expires_at);

-- D1-backed fixed-window counters provide a durable fallback when requests
-- are spread across multiple Cloudflare isolates. The compound key is already
-- HMAC'd by the application and contains no raw IP or user identifiers.
CREATE TABLE IF NOT EXISTS playback_rate_limits (
  bucket_key TEXT PRIMARY KEY,
  window_started_at INTEGER NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0 CHECK (request_count >= 0),
  blocked_until INTEGER,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_playback_rate_limits_updated
  ON playback_rate_limits(updated_at);

CREATE TABLE IF NOT EXISTS playback_security_events (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  user_id TEXT,
  series_id TEXT,
  episode_no INTEGER CHECK (episode_no IS NULL OR episode_no > 0),
  event_type TEXT NOT NULL CHECK (length(event_type) <= 64),
  device_hash TEXT,
  ip_hash TEXT,
  detail TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(user_id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_playback_security_events_created
  ON playback_security_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_playback_security_events_user_created
  ON playback_security_events(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_playback_security_events_type_created
  ON playback_security_events(event_type, created_at DESC);

