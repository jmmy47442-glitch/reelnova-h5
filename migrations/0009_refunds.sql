PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS refund_requests (
  id TEXT PRIMARY KEY,
  order_no TEXT NOT NULL,
  capture_id TEXT NOT NULL,
  paypal_refund_id TEXT UNIQUE,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  currency TEXT NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  reason TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  FOREIGN KEY(order_no) REFERENCES orders(order_no)
);

CREATE INDEX IF NOT EXISTS idx_refund_requests_order ON refund_requests(order_no, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_refund_requests_status ON refund_requests(status, updated_at DESC);
