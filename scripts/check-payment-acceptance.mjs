import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const envFile = process.env.ACCEPTANCE_ENV_FILE || '.env';
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].trim().replace(/^["']|["']$/g, '');
  }
}

const { CLOUDFLARE_ACCOUNT_ID: accountId, CLOUDFLARE_D1_DATABASE_ID: databaseId, CLOUDFLARE_API_TOKEN: apiToken } = process.env;
if (!accountId || !databaseId || !apiToken) throw new Error('CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_D1_DATABASE_ID and CLOUDFLARE_API_TOKEN are required');

const endpoint = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/d1/database/${encodeURIComponent(databaseId)}/query`;
const query = async (sql, params = []) => {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql, params }),
  });
  const payload = await response.json().catch(() => ({}));
  const failed = payload.result?.find((result) => !result.success);
  if (!response.ok || !payload.success || failed) throw new Error(failed?.error || payload.errors?.[0]?.message || `D1 request failed (${response.status})`);
  return payload.result?.[0]?.results || [];
};

const paidOrderNo = process.env.ACCEPTANCE_PAID_ORDER_NO || '';
const cancelledOrderNo = process.env.ACCEPTANCE_CANCELLED_ORDER_NO || '';
const refundedOrderNo = process.env.ACCEPTANCE_REFUNDED_ORDER_NO || '';
const [successfulPayment] = await query(`SELECT o.order_no, o.paypal_order_id, o.capture_id, o.status, o.created_at,
  e.status AS entitlement_status, w.event_id AS capture_webhook_event_id, w.delivery_count AS capture_webhook_delivery_count
  FROM orders o
  JOIN entitlements e ON e.order_no = o.order_no
  JOIN paypal_webhook_events w ON w.paypal_order_id = o.paypal_order_id
    AND w.event_type = 'PAYMENT.CAPTURE.COMPLETED' AND w.verification_status = 'SUCCESS' AND w.processing_status = 'processed'
  WHERE o.paypal_environment = 'sandbox' AND o.capture_id IS NOT NULL AND o.order_no NOT LIKE 'RN-ACCEPT-%'
    AND o.status = 'paid' AND e.status = 'granted'
    AND (? = '' OR o.order_no = ?)
  ORDER BY o.created_at DESC LIMIT 1`, [paidOrderNo, paidOrderNo]);

const [cancelledPayment] = await query(`SELECT order_no, paypal_order_id, status, created_at
  FROM orders WHERE paypal_environment = 'sandbox' AND status = 'cancelled' AND order_no NOT LIKE 'RN-ACCEPT-%'
    AND (? = '' OR order_no = ?)
  ORDER BY created_at DESC LIMIT 1`, [cancelledOrderNo, cancelledOrderNo]);

const [refundedPayment] = await query(`SELECT o.order_no, o.paypal_order_id, o.capture_id, o.status, o.created_at,
  e.status AS entitlement_status, e.revoked_at, r.id AS refund_request_id, r.paypal_refund_id,
  r.status AS refund_status, r.request_source, r.provider_status, r.entitlement_revoke_status, r.completed_at
  FROM orders o
  JOIN entitlements e ON e.order_no = o.order_no
  JOIN refund_requests r ON r.order_no = o.order_no
  WHERE o.paypal_environment = 'sandbox' AND o.status = 'refunded' AND o.order_no NOT LIKE 'RN-ACCEPT-%'
    AND (? = '' OR o.order_no = ?)
  ORDER BY o.created_at DESC LIMIT 1`, [refundedOrderNo, refundedOrderNo]);

const [refundWebhook] = refundedPayment ? await query(`SELECT event_id, event_type, verification_status, processing_status,
  delivery_count, received_at, processed_at
  FROM paypal_webhook_events
  WHERE event_type IN ('PAYMENT.CAPTURE.REFUNDED', 'PAYMENT.CAPTURE.REVERSED', 'PAYMENT.REFUND.COMPLETED')
    AND json_extract(payload_json, '$.resource.id') = ?
  ORDER BY received_at DESC LIMIT 1`, [refundedPayment.paypal_refund_id]) : [];

const [duplicateWebhook] = await query(`SELECT w.event_id, w.event_type, w.delivery_count, w.received_at, w.last_received_at
  FROM paypal_webhook_events w JOIN orders o ON o.paypal_order_id = w.paypal_order_id
  WHERE o.paypal_environment = 'sandbox' AND w.verification_status = 'SUCCESS' AND w.processing_status = 'processed'
    AND w.delivery_count >= 2 AND w.event_type = 'PAYMENT.CAPTURE.COMPLETED'
  ORDER BY w.last_received_at DESC LIMIT 1`);

const checks = {
  sandboxPaymentCompleted: Boolean(successfulPayment?.capture_id && ['paid', 'refunded'].includes(successfulPayment.status)),
  captureWebhookProcessed: Boolean(successfulPayment?.capture_webhook_event_id),
  entitlementGrantedByPayment: Boolean(successfulPayment?.entitlement_status),
  sandboxCancellationRecorded: cancelledPayment?.status === 'cancelled',
  duplicateWebhookRecorded: Number(duplicateWebhook?.delivery_count || 0) >= 2,
  sandboxRefundCompleted: refundedPayment?.refund_status === 'completed' && refundedPayment?.provider_status === 'COMPLETED'
    && refundedPayment?.request_source === 'paypal_api' && Boolean(refundedPayment?.paypal_refund_id),
  refundWebhookProcessed: refundWebhook?.verification_status === 'SUCCESS' && refundWebhook?.processing_status === 'processed',
  entitlementRevokedAfterRefund: refundedPayment?.entitlement_status === 'revoked'
    && refundedPayment?.entitlement_revoke_status === 'revoked' && Boolean(refundedPayment?.revoked_at),
};
const passed = Object.values(checks).every(Boolean);
const evidence = {
  schemaVersion: 1,
  checkedAt: new Date().toISOString(),
  environment: 'sandbox',
  passed,
  checks,
  records: {
    successfulPayment: successfulPayment || null,
    cancelledPayment: cancelledPayment || null,
    refundedPayment: refundedPayment || null,
    refundWebhook: refundWebhook || null,
    duplicateWebhook: duplicateWebhook || null,
  },
};

const outputIndex = process.argv.indexOf('--output');
if (outputIndex >= 0) {
  const outputName = process.argv[outputIndex + 1];
  if (!outputName) throw new Error('--output requires a file path');
  const outputPath = resolve(outputName);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  console.log(`Acceptance evidence written to ${outputPath}`);
}
console.log(JSON.stringify(evidence, null, 2));
if (!passed) process.exitCode = 1;
