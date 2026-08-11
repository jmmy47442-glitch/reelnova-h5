PRAGMA foreign_keys = OFF;

ALTER TABLE refund_requests RENAME TO refund_requests_legacy;

CREATE TABLE refund_requests (
  id TEXT PRIMARY KEY,
  order_no TEXT NOT NULL,
  capture_id TEXT NOT NULL,
  paypal_refund_id TEXT UNIQUE,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  currency TEXT NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'rejected', 'cancelled')),
  request_source TEXT NOT NULL DEFAULT 'paypal_api' CHECK (request_source IN ('paypal_api', 'manual', 'webhook')),
  provider_status TEXT,
  customer_service_result TEXT NOT NULL DEFAULT 'approved' CHECK (customer_service_result IN ('approved', 'rejected')),
  entitlement_revoke_status TEXT NOT NULL DEFAULT 'pending' CHECK (entitlement_revoke_status IN ('pending', 'revoked', 'not_applicable', 'failed')),
  reason TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  resolved_by TEXT,
  resolution_note TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  provider_request_id TEXT,
  last_attempt_at TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  FOREIGN KEY(order_no) REFERENCES orders(order_no)
);

INSERT INTO refund_requests (
  id, order_no, capture_id, paypal_refund_id, amount_cents, currency, status,
  request_source, provider_status, customer_service_result, entitlement_revoke_status,
  reason, requested_by, attempt_count, error_message, created_at, updated_at, completed_at
)
SELECT
  id, order_no, capture_id, paypal_refund_id, amount_cents, currency, status,
  'paypal_api', CASE WHEN status = 'completed' THEN 'COMPLETED' ELSE NULL END, 'approved',
  CASE WHEN status = 'completed' THEN 'revoked' ELSE 'pending' END,
  reason, requested_by, 0, error_message, created_at, updated_at, completed_at
FROM refund_requests_legacy;

DROP TABLE refund_requests_legacy;

CREATE INDEX idx_refund_requests_order ON refund_requests(order_no, created_at DESC);
CREATE INDEX idx_refund_requests_status ON refund_requests(status, updated_at DESC);

CREATE TABLE refund_events (
  id TEXT PRIMARY KEY,
  refund_request_id TEXT NOT NULL,
  order_no TEXT NOT NULL,
  event_type TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('admin', 'paypal_api', 'paypal_webhook', 'system')),
  actor TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT NOT NULL,
  paypal_event_id TEXT,
  paypal_refund_id TEXT,
  detail TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(refund_request_id) REFERENCES refund_requests(id),
  FOREIGN KEY(order_no) REFERENCES orders(order_no)
);

CREATE UNIQUE INDEX idx_refund_events_paypal_event
  ON refund_events(paypal_event_id)
  WHERE paypal_event_id IS NOT NULL;
CREATE INDEX idx_refund_events_request ON refund_events(refund_request_id, created_at DESC);
CREATE INDEX idx_refund_events_order ON refund_events(order_no, created_at DESC);

ALTER TABLE paypal_webhook_events ADD COLUMN payload_json TEXT;
ALTER TABLE paypal_webhook_events ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE paypal_webhook_events ADD COLUMN last_retry_at TEXT;

PRAGMA foreign_keys = ON;
