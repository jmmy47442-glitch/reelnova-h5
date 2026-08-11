PRAGMA foreign_keys = ON;

ALTER TABLE orders ADD COLUMN approval_url TEXT;
ALTER TABLE orders ADD COLUMN idempotency_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_user_series_idempotency
  ON orders(user_id, series_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_orders_user_series_status
  ON orders(user_id, series_id, status, created_at DESC);
