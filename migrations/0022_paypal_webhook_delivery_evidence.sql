ALTER TABLE paypal_webhook_events ADD COLUMN delivery_count INTEGER NOT NULL DEFAULT 1;
ALTER TABLE paypal_webhook_events ADD COLUMN last_received_at TEXT;

UPDATE paypal_webhook_events SET last_received_at = received_at WHERE last_received_at IS NULL;
