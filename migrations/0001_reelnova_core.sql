PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS orders (
  order_no TEXT PRIMARY KEY,
  series_id TEXT NOT NULL,
  series_slug TEXT NOT NULL,
  series_title TEXT NOT NULL,
  visitor_id TEXT NOT NULL,
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
  callback_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_orders_status_created ON orders(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_series_created ON orders(series_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_paypal ON orders(paypal_order_id);

CREATE TABLE IF NOT EXISTS entitlements (
  id TEXT PRIMARY KEY,
  visitor_id TEXT NOT NULL,
  series_id TEXT NOT NULL,
  order_no TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('granted', 'revoked')),
  granted_at TEXT NOT NULL,
  revoked_at TEXT,
  UNIQUE(visitor_id, series_id),
  FOREIGN KEY(order_no) REFERENCES orders(order_no)
);

CREATE INDEX IF NOT EXISTS idx_entitlements_visitor ON entitlements(visitor_id, status);

CREATE TABLE IF NOT EXISTS playback_events (
  event_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  visitor_id TEXT NOT NULL,
  series_id TEXT NOT NULL,
  series_title TEXT NOT NULL,
  episode_no INTEGER NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('start', 'heartbeat', 'complete')),
  position_seconds INTEGER NOT NULL DEFAULT 0,
  duration_seconds INTEGER NOT NULL DEFAULT 0,
  country TEXT,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_playback_unique_start
  ON playback_events(session_id, series_id, episode_no, event_type)
  WHERE event_type = 'start';
CREATE INDEX IF NOT EXISTS idx_playback_created ON playback_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_playback_series_created ON playback_events(series_id, created_at DESC);

CREATE TABLE IF NOT EXISTS paypal_webhook_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  paypal_order_id TEXT,
  verification_status TEXT NOT NULL CHECK (verification_status IN ('SUCCESS', 'FAILURE')),
  processing_status TEXT NOT NULL CHECK (processing_status IN ('processed', 'ignored', 'failed')),
  error_message TEXT,
  received_at TEXT NOT NULL,
  processed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_webhooks_received ON paypal_webhook_events(received_at DESC);
