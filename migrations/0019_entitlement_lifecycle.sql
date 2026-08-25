PRAGMA foreign_keys = ON;

-- Payment entitlements are derived from the durable order state. Keeping the
-- grant/revoke mutations in triggers makes each order transition atomic even
-- when capture and webhook deliveries race or are retried.
CREATE TRIGGER IF NOT EXISTS grant_paid_order_entitlement
AFTER UPDATE OF status ON orders
WHEN NEW.status = 'paid'
BEGIN
  INSERT INTO entitlements (id, user_id, series_id, order_no, status, granted_at, revoked_at)
  VALUES ('payment_entitlement:' || NEW.order_no, NEW.user_id, NEW.series_id, NEW.order_no, 'granted',
    COALESCE(NEW.callback_at, NEW.updated_at), NULL)
  ON CONFLICT(user_id, series_id) DO UPDATE SET
    order_no = excluded.order_no,
    status = 'granted',
    granted_at = excluded.granted_at,
    revoked_at = NULL
  WHERE entitlements.order_no = excluded.order_no OR entitlements.status = 'revoked';
END;

CREATE TRIGGER IF NOT EXISTS revoke_refunded_order_entitlement
AFTER UPDATE OF status ON orders
WHEN NEW.status = 'refunded'
BEGIN
  UPDATE entitlements
  SET status = 'revoked', revoked_at = COALESCE(revoked_at, NEW.updated_at)
  WHERE order_no = NEW.order_no AND status = 'granted';

  -- A legacy/concurrent duplicate capture may leave another genuinely paid
  -- order for the same series. Preserve access from that order while still
  -- keeping one entitlement row in total.
  INSERT INTO entitlements (id, user_id, series_id, order_no, status, granted_at, revoked_at)
  SELECT 'payment_entitlement:' || o.order_no, o.user_id, o.series_id, o.order_no, 'granted',
    COALESCE(o.callback_at, o.updated_at), NULL
  FROM orders o
  WHERE o.user_id = NEW.user_id
    AND o.series_id = NEW.series_id
    AND o.order_no != NEW.order_no
    AND o.status IN ('paid', 'refunding')
  ORDER BY COALESCE(o.callback_at, o.updated_at) DESC
  LIMIT 1
  ON CONFLICT(user_id, series_id) DO UPDATE SET
    order_no = excluded.order_no,
    status = 'granted',
    granted_at = excluded.granted_at,
    revoked_at = NULL
  WHERE entitlements.status = 'revoked';
END;

-- Application code must not manufacture a payment entitlement without a
-- matching paid order. Manual customer-service grants use their own table.
CREATE TRIGGER IF NOT EXISTS validate_payment_entitlement_insert
BEFORE INSERT ON entitlements
WHEN NEW.status = 'granted' AND NOT EXISTS (
  SELECT 1 FROM orders
  WHERE order_no = NEW.order_no
    AND user_id = NEW.user_id
    AND series_id = NEW.series_id
    AND status IN ('paid', 'refunding')
)
BEGIN
  SELECT RAISE(ABORT, 'granted entitlement requires a matching paid order');
END;

CREATE TRIGGER IF NOT EXISTS validate_payment_entitlement_update
BEFORE UPDATE OF user_id, series_id, order_no, status ON entitlements
WHEN NEW.status = 'granted' AND NOT EXISTS (
  SELECT 1 FROM orders
  WHERE order_no = NEW.order_no
    AND user_id = NEW.user_id
    AND series_id = NEW.series_id
    AND status IN ('paid', 'refunding')
)
BEGIN
  SELECT RAISE(ABORT, 'granted entitlement requires a matching paid order');
END;

-- Repair any historical paid row that was committed before its entitlement.
-- A current paid/refunding order may reactivate a previously revoked row, while
-- an already granted entitlement is never transferred to a second order.
INSERT OR IGNORE INTO entitlements (id, user_id, series_id, order_no, status, granted_at, revoked_at)
SELECT 'payment_entitlement:' || o.order_no, o.user_id, o.series_id, o.order_no, 'granted',
  COALESCE(o.callback_at, o.updated_at), NULL
FROM orders o
WHERE o.status IN ('paid', 'refunding')
ORDER BY COALESCE(o.callback_at, o.updated_at) DESC;

UPDATE entitlements
SET order_no = (
      SELECT o.order_no FROM orders o
      WHERE o.user_id = entitlements.user_id
        AND o.series_id = entitlements.series_id
        AND o.status IN ('paid', 'refunding')
      ORDER BY COALESCE(o.callback_at, o.updated_at) DESC LIMIT 1
    ),
    status = 'granted',
    granted_at = (
      SELECT COALESCE(o.callback_at, o.updated_at) FROM orders o
      WHERE o.user_id = entitlements.user_id
        AND o.series_id = entitlements.series_id
        AND o.status IN ('paid', 'refunding')
      ORDER BY COALESCE(o.callback_at, o.updated_at) DESC LIMIT 1
    ),
    revoked_at = NULL
WHERE status = 'revoked'
  AND EXISTS (
    SELECT 1 FROM orders o
    WHERE o.user_id = entitlements.user_id
      AND o.series_id = entitlements.series_id
      AND o.status IN ('paid', 'refunding')
  );
