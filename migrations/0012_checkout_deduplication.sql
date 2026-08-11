PRAGMA foreign_keys = ON;

ALTER TABLE orders ADD COLUMN business_idempotency_key TEXT;
ALTER TABLE orders ADD COLUMN price_version TEXT;
ALTER TABLE orders ADD COLUMN pricing_snapshot_json TEXT;
ALTER TABLE orders ADD COLUMN activity_snapshot_json TEXT;

UPDATE orders
SET business_idempotency_key = 'series-purchase:' || user_id || ':' || series_id,
    price_version = 'legacy',
    pricing_snapshot_json = json_object(
      'seriesId', series_id,
      'seriesSlug', series_slug,
      'seriesTitle', series_title,
      'amountCents', amount_cents,
      'currency', currency,
      'priceVersion', 'legacy'
    ),
    activity_snapshot_json = json_object(
      'activityCode', NULL,
      'originalAmountCents', amount_cents,
      'discountPercent', 0
    )
WHERE business_idempotency_key IS NULL;

UPDATE orders
SET status = 'cancelled',
    note = COALESCE(note || '; ', '') || 'Superseded by an existing entitlement',
    updated_at = datetime('now')
WHERE status IN ('pending', 'processing')
  AND (
    EXISTS (
      SELECT 1 FROM entitlements
      WHERE entitlements.user_id = orders.user_id
        AND entitlements.series_id = orders.series_id
        AND entitlements.status = 'granted'
    )
    OR EXISTS (
      SELECT 1 FROM manual_entitlements
      WHERE manual_entitlements.user_id = orders.user_id
        AND manual_entitlements.series_id = orders.series_id
        AND manual_entitlements.status = 'granted'
    )
  );

-- Keep the most useful resumable checkout before adding the concurrency guard.
-- Superseded local rows can no longer be returned as the checkout to continue.
WITH ranked_open_orders AS (
  SELECT order_no,
    ROW_NUMBER() OVER (
      PARTITION BY user_id, series_id
      ORDER BY CASE WHEN paypal_order_id IS NOT NULL AND approval_url IS NOT NULL THEN 0 ELSE 1 END,
        updated_at DESC, created_at DESC, order_no DESC
    ) AS position
  FROM orders
  WHERE status IN ('pending', 'processing')
)
UPDATE orders
SET status = 'cancelled',
    note = COALESCE(note || '; ', '') || 'Superseded by checkout concurrency migration',
    updated_at = datetime('now')
WHERE order_no IN (SELECT order_no FROM ranked_open_orders WHERE position > 1);

CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_one_open_checkout
  ON orders(user_id, series_id)
  WHERE status IN ('pending', 'processing');

CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_active_business_idempotency
  ON orders(business_idempotency_key)
  WHERE business_idempotency_key IS NOT NULL
    AND status IN ('pending', 'processing');

CREATE INDEX IF NOT EXISTS idx_orders_business_idempotency
  ON orders(business_idempotency_key, created_at DESC);

CREATE TRIGGER IF NOT EXISTS validate_order_checkout_snapshot_insert
BEFORE INSERT ON orders
WHEN NEW.business_idempotency_key IS NULL
  OR NEW.price_version IS NULL
  OR NEW.pricing_snapshot_json IS NULL
  OR NOT json_valid(NEW.pricing_snapshot_json)
  OR NEW.activity_snapshot_json IS NULL
  OR NOT json_valid(NEW.activity_snapshot_json)
BEGIN
  SELECT RAISE(ABORT, 'order checkout idempotency and pricing snapshots are required');
END;

CREATE TRIGGER IF NOT EXISTS protect_order_checkout_snapshot_update
BEFORE UPDATE OF business_idempotency_key, price_version, pricing_snapshot_json, activity_snapshot_json ON orders
WHEN NEW.business_idempotency_key IS NOT OLD.business_idempotency_key
  OR NEW.price_version IS NOT OLD.price_version
  OR NEW.pricing_snapshot_json IS NOT OLD.pricing_snapshot_json
  OR NEW.activity_snapshot_json IS NOT OLD.activity_snapshot_json
BEGIN
  SELECT RAISE(ABORT, 'order checkout idempotency and pricing snapshots are immutable');
END;

CREATE TRIGGER IF NOT EXISTS prevent_manual_entitlement_during_checkout_insert
BEFORE INSERT ON manual_entitlements
WHEN NEW.status = 'granted' AND EXISTS (
  SELECT 1 FROM orders
  WHERE user_id = NEW.user_id AND series_id = NEW.series_id
    AND status IN ('pending', 'processing')
)
BEGIN
  SELECT RAISE(ABORT, 'cannot grant manual entitlement during an open checkout');
END;

CREATE TRIGGER IF NOT EXISTS prevent_manual_entitlement_during_checkout_update
BEFORE UPDATE OF status ON manual_entitlements
WHEN NEW.status = 'granted' AND EXISTS (
  SELECT 1 FROM orders
  WHERE user_id = NEW.user_id AND series_id = NEW.series_id
    AND status IN ('pending', 'processing')
)
BEGIN
  SELECT RAISE(ABORT, 'cannot grant manual entitlement during an open checkout');
END;
