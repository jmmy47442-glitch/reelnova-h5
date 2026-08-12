PRAGMA foreign_keys = ON;

ALTER TABLE orders ADD COLUMN paypal_environment TEXT
  CHECK (paypal_environment IN ('sandbox', 'production'));

CREATE INDEX IF NOT EXISTS idx_orders_paypal_environment
  ON orders(paypal_environment, paypal_order_id);

CREATE TRIGGER IF NOT EXISTS require_order_paypal_environment_insert
BEFORE INSERT ON orders
WHEN NEW.paypal_environment IS NULL
BEGIN
  SELECT RAISE(ABORT, 'order PayPal environment is required');
END;

CREATE TRIGGER IF NOT EXISTS protect_order_paypal_environment_update
BEFORE UPDATE OF paypal_environment ON orders
WHEN OLD.paypal_environment IS NOT NULL
  AND NEW.paypal_environment IS NOT OLD.paypal_environment
BEGIN
  SELECT RAISE(ABORT, 'order PayPal environment is immutable');
END;
