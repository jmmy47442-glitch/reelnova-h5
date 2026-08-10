PRAGMA foreign_keys = OFF;

-- Merge the registered account fields into the profile table. Existing
-- visitor_id values are preserved as user_id so historical business data
-- keeps the same owner.
ALTER TABLE users RENAME TO users_legacy;
CREATE TABLE users_new (
  user_id TEXT PRIMARY KEY,
  email TEXT COLLATE NOCASE,
  display_name TEXT,
  password_salt TEXT,
  password_hash TEXT,
  last_login_at TEXT,
  country TEXT,
  device TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'restricted', 'disabled')),
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO users_new
  (user_id, email, display_name, password_salt, password_hash, last_login_at,
   country, device, status, created_at, last_seen_at, updated_at)
SELECT
  u.visitor_id,
  COALESCE(a.email, u.email),
  a.display_name,
  a.password_salt,
  a.password_hash,
  a.last_login_at,
  u.country,
  u.device,
  u.status,
  COALESCE(a.created_at, u.created_at),
  u.last_seen_at,
  MAX(u.updated_at, COALESCE(a.updated_at, u.updated_at))
FROM users_legacy u
LEFT JOIN user_accounts a ON a.visitor_id = u.visitor_id;

-- Rows without a matching account are retained for historical orders, plays
-- and entitlements, but have no password_hash and cannot authenticate.

DROP TABLE user_accounts;
DROP TABLE users_legacy;
ALTER TABLE users_new RENAME TO users;

CREATE INDEX idx_users_email ON users(email);
CREATE UNIQUE INDEX idx_users_account_email
  ON users(email COLLATE NOCASE)
  WHERE password_hash IS NOT NULL;
CREATE INDEX idx_users_country_status ON users(country, status);
CREATE INDEX idx_users_last_seen ON users(last_seen_at DESC);

ALTER TABLE orders RENAME TO orders_legacy;
CREATE TABLE orders_new (
  order_no TEXT PRIMARY KEY,
  series_id TEXT NOT NULL,
  series_slug TEXT NOT NULL,
  series_title TEXT NOT NULL,
  user_id TEXT NOT NULL,
  email TEXT,
  country TEXT,
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  currency TEXT NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  fee_cents INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'paid', 'failed', 'cancelled', 'refunding', 'refunded', 'risk_review')),
  paypal_order_id TEXT UNIQUE,
  capture_id TEXT UNIQUE,
  note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  callback_at TEXT,
  FOREIGN KEY(user_id) REFERENCES users(user_id)
);
INSERT INTO orders_new
  (order_no, series_id, series_slug, series_title, user_id, email, country,
   amount_cents, currency, fee_cents, status, paypal_order_id, capture_id, note,
   created_at, updated_at, callback_at)
SELECT order_no, series_id, series_slug, series_title, visitor_id, email, country,
  amount_cents, currency, fee_cents, status, paypal_order_id, capture_id, note,
  created_at, updated_at, callback_at
FROM orders_legacy;
DROP TABLE orders_legacy;
ALTER TABLE orders_new RENAME TO orders;
CREATE INDEX idx_orders_status_created ON orders(status, created_at DESC);
CREATE INDEX idx_orders_series_created ON orders(series_id, created_at DESC);
CREATE INDEX idx_orders_paypal ON orders(paypal_order_id);

ALTER TABLE entitlements RENAME TO entitlements_legacy;
CREATE TABLE entitlements_new (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  series_id TEXT NOT NULL,
  order_no TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('granted', 'revoked')),
  granted_at TEXT NOT NULL,
  revoked_at TEXT,
  UNIQUE(user_id, series_id),
  FOREIGN KEY(user_id) REFERENCES users(user_id),
  FOREIGN KEY(order_no) REFERENCES orders(order_no)
);
INSERT INTO entitlements_new (id, user_id, series_id, order_no, status, granted_at, revoked_at)
SELECT id, visitor_id, series_id, order_no, status, granted_at, revoked_at
FROM entitlements_legacy;
DROP TABLE entitlements_legacy;
ALTER TABLE entitlements_new RENAME TO entitlements;
CREATE INDEX idx_entitlements_user ON entitlements(user_id, status);

ALTER TABLE playback_events RENAME TO playback_events_legacy;
CREATE TABLE playback_events_new (
  event_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  series_id TEXT NOT NULL,
  series_title TEXT NOT NULL,
  episode_no INTEGER NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('start', 'heartbeat', 'complete')),
  position_seconds INTEGER NOT NULL DEFAULT 0,
  duration_seconds INTEGER NOT NULL DEFAULT 0,
  country TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(user_id)
);
INSERT INTO playback_events_new
  (event_id, session_id, user_id, series_id, series_title, episode_no, event_type,
   position_seconds, duration_seconds, country, created_at)
SELECT event_id, session_id, visitor_id, series_id, series_title, episode_no, event_type,
  position_seconds, duration_seconds, country, created_at
FROM playback_events_legacy;
DROP TABLE playback_events_legacy;
ALTER TABLE playback_events_new RENAME TO playback_events;
CREATE UNIQUE INDEX idx_playback_unique_start
  ON playback_events(session_id, series_id, episode_no, event_type)
  WHERE event_type = 'start';
CREATE INDEX idx_playback_created ON playback_events(created_at DESC);
CREATE INDEX idx_playback_series_created ON playback_events(series_id, created_at DESC);

ALTER TABLE manual_entitlements RENAME TO manual_entitlements_legacy;
CREATE TABLE manual_entitlements_new (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  series_id TEXT NOT NULL,
  series_title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'granted' CHECK (status IN ('granted', 'revoked')),
  reason TEXT NOT NULL,
  granted_by TEXT NOT NULL,
  granted_at TEXT NOT NULL,
  revoked_at TEXT,
  UNIQUE(user_id, series_id),
  FOREIGN KEY(user_id) REFERENCES users(user_id)
);
INSERT INTO manual_entitlements_new
  (id, user_id, series_id, series_title, status, reason, granted_by, granted_at, revoked_at)
SELECT id, visitor_id, series_id, series_title, status, reason, granted_by, granted_at, revoked_at
FROM manual_entitlements_legacy;
DROP TABLE manual_entitlements_legacy;
ALTER TABLE manual_entitlements_new RENAME TO manual_entitlements;
CREATE INDEX idx_manual_entitlements_user ON manual_entitlements(user_id, status);

ALTER TABLE admin_user_actions RENAME TO admin_user_actions_legacy;
CREATE TABLE admin_user_actions_new (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('status_change', 'device_restriction_release', 'entitlement_grant')),
  detail TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(user_id)
);
INSERT INTO admin_user_actions_new (id, user_id, actor, action, detail, created_at)
SELECT id, visitor_id, actor, action, detail, created_at
FROM admin_user_actions_legacy;
DROP TABLE admin_user_actions_legacy;
ALTER TABLE admin_user_actions_new RENAME TO admin_user_actions;
CREATE INDEX idx_admin_user_actions_user ON admin_user_actions(user_id, created_at DESC);
CREATE INDEX idx_admin_user_actions_created ON admin_user_actions(created_at DESC);

PRAGMA foreign_keys = ON;
PRAGMA foreign_key_check;
