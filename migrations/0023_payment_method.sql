ALTER TABLE orders ADD COLUMN payment_provider TEXT NOT NULL DEFAULT 'paypal' CHECK (payment_provider IN ('paypal'));
ALTER TABLE orders ADD COLUMN payment_method TEXT NOT NULL DEFAULT 'paypal' CHECK (payment_method IN ('paypal', 'card', 'apple_pay'));
CREATE INDEX IF NOT EXISTS idx_orders_payment_method ON orders(payment_provider, payment_method, created_at DESC);
