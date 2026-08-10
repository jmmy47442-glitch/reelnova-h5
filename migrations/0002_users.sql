PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  visitor_id TEXT PRIMARY KEY,
  email TEXT,
  country TEXT,
  device TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'restricted', 'disabled')),
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_country_status ON users(country, status);
CREATE INDEX IF NOT EXISTS idx_users_last_seen ON users(last_seen_at DESC);

CREATE TABLE IF NOT EXISTS manual_entitlements (
  id TEXT PRIMARY KEY,
  visitor_id TEXT NOT NULL,
  series_id TEXT NOT NULL,
  series_title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'granted' CHECK (status IN ('granted', 'revoked')),
  reason TEXT NOT NULL,
  granted_by TEXT NOT NULL,
  granted_at TEXT NOT NULL,
  revoked_at TEXT,
  UNIQUE(visitor_id, series_id),
  FOREIGN KEY(visitor_id) REFERENCES users(visitor_id)
);

CREATE INDEX IF NOT EXISTS idx_manual_entitlements_visitor ON manual_entitlements(visitor_id, status);

CREATE TABLE IF NOT EXISTS admin_user_actions (
  id TEXT PRIMARY KEY,
  visitor_id TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('status_change', 'device_restriction_release', 'entitlement_grant')),
  detail TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(visitor_id) REFERENCES users(visitor_id)
);

CREATE INDEX IF NOT EXISTS idx_admin_user_actions_visitor ON admin_user_actions(visitor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_user_actions_created ON admin_user_actions(created_at DESC);

-- Preserve visitors that existed before the user profile table was introduced.
INSERT INTO users (visitor_id, email, country, device, status, created_at, last_seen_at, updated_at)
SELECT visitor_id, MAX(email), MAX(country), NULL, 'active', MIN(created_at), MAX(last_seen_at), MAX(last_seen_at)
FROM (
  SELECT visitor_id, email, country, created_at, updated_at AS last_seen_at FROM orders
  UNION ALL
  SELECT visitor_id, NULL AS email, country, created_at, created_at AS last_seen_at FROM playback_events
  UNION ALL
  SELECT visitor_id, NULL AS email, NULL AS country, granted_at AS created_at,
    COALESCE(revoked_at, granted_at) AS last_seen_at FROM entitlements
)
GROUP BY visitor_id
ON CONFLICT(visitor_id) DO NOTHING;
