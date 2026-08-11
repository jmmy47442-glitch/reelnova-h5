import { ok } from '~/server/utils/response';
import { d1All, d1First } from '~/server/utils/cloudflare-d1';

interface RefundRow {
  id: string; order_no: string; paypal_refund_id: string | null; amount_cents: number; currency: string; status: string;
  request_source: string; provider_status: string | null; customer_service_result: string; entitlement_revoke_status: string;
  reason: string; requested_by: string; resolved_by: string | null; resolution_note: string | null; attempt_count: number;
  provider_request_id: string | null; last_attempt_at: string | null; error_message: string | null; created_at: string; updated_at: string; completed_at: string | null;
}

interface RefundEventRow {
  id: string; event_type: string; source: string; actor: string; from_status: string | null; to_status: string;
  paypal_event_id: string | null; paypal_refund_id: string | null; detail: string; created_at: string;
}

export default defineEventHandler(async (event) => {
  const orderNo = getRouterParam(event, 'orderNo') || '';
  const order = await d1First<{ order_no: string }>(event, 'SELECT order_no FROM orders WHERE order_no = ?', [orderNo]);
  if (!order) throw createError({ statusCode: 404, statusMessage: 'Order not found' });
  const requests = await d1All<RefundRow>(event, 'SELECT * FROM refund_requests WHERE order_no = ? ORDER BY created_at DESC', [orderNo]);
  const events = await d1All<RefundEventRow>(event, 'SELECT id, event_type, source, actor, from_status, to_status, paypal_event_id, paypal_refund_id, detail, created_at FROM refund_events WHERE order_no = ? ORDER BY created_at DESC', [orderNo]);
  return ok({
    orderNo,
    requests: requests.map((row) => ({
      id: row.id, paypalRefundId: row.paypal_refund_id, amount: Number(row.amount_cents) / 100, currency: row.currency,
      status: row.status, source: row.request_source, providerStatus: row.provider_status,
      customerServiceResult: row.customer_service_result, entitlementRevokeStatus: row.entitlement_revoke_status,
      reason: row.reason, requestedBy: row.requested_by, resolvedBy: row.resolved_by, resolutionNote: row.resolution_note,
      attemptCount: Number(row.attempt_count), providerRequestId: row.provider_request_id, lastAttemptAt: row.last_attempt_at, errorMessage: row.error_message,
      createdAt: row.created_at, updatedAt: row.updated_at, completedAt: row.completed_at,
    })),
    events: events.map((row) => ({
      id: row.id, eventType: row.event_type, source: row.source, actor: row.actor, fromStatus: row.from_status,
      toStatus: row.to_status, paypalEventId: row.paypal_event_id, paypalRefundId: row.paypal_refund_id,
      detail: row.detail, createdAt: row.created_at,
    })),
  });
});
