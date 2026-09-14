import { ok } from '~/server/utils/response';
import { d1Batch, d1First } from '~/server/utils/cloudflare-d1';
import { getUserSession } from '~/server/utils/user-auth';
import type { Order } from '~/types/content';

export default defineEventHandler(async (event) => {
  const session = await getUserSession(event);
  if (!session) throw createError({ statusCode: 401, statusMessage: 'Login required' });
  const orderNo = getRouterParam(event, 'orderNo') || '';
  const order = await d1First<{ status: string; capture_id: string | null; amount_cents: number }>(event,
    'SELECT status, capture_id, amount_cents FROM orders WHERE order_no = ? AND user_id = ?', [orderNo, session.userId]);
  if (!order) throw createError({ statusCode: 404, statusMessage: 'Order not found' });
  const getRefund = () => d1First<{ status: NonNullable<Order['refundStatus']> }>(event,
    'SELECT status FROM refund_requests WHERE order_no = ? ORDER BY created_at DESC LIMIT 1', [orderNo]);
  const existing = await getRefund();
  if (existing) return ok({ orderNo, refundStatus: existing.status });
  if (order.status !== 'paid' || !order.capture_id || order.amount_cents <= 0) {
    throw createError({ statusCode: 409, statusMessage: 'Only captured paid orders can be refunded' });
  }
  const body = await readBody<{ reason?: unknown }>(event);
  const reason = typeof body?.reason === 'string' ? body.reason.trim() : '';
  if (reason.length < 8 || reason.length > 500) {
    throw createError({ statusCode: 400, statusMessage: 'Refund reason must be 8-500 characters' });
  }
  const requestId = `refund_${orderNo}`;
  const now = new Date().toISOString();
  // Keep access active during manual review. Only a verified refund revokes it.
  // The shared request ID and atomic batch make customer retries idempotent.
  await d1Batch(event, [
    {
      sql: `INSERT INTO refund_requests
        (id, order_no, capture_id, amount_cents, currency, status, request_source, reason, requested_by, created_at, updated_at)
        SELECT ?, order_no, capture_id, amount_cents, currency, 'pending', 'manual', ?, ?, ?, ?
        FROM orders WHERE order_no = ? AND user_id = ? AND status = 'paid' AND capture_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM refund_requests WHERE order_no = ?)
        ON CONFLICT(id) DO NOTHING`,
      params: [requestId, reason, session.userId, now, now, orderNo, session.userId, orderNo],
    },
    {
      sql: `INSERT INTO refund_events
        (id, refund_request_id, order_no, event_type, source, actor, to_status, detail, created_at)
        SELECT ?, id, order_no, 'customer_refund_requested', 'system', requested_by, 'pending', reason, created_at
        FROM refund_requests WHERE id = ? AND requested_by = ? AND status = 'pending' AND attempt_count = 0
        ON CONFLICT(id) DO NOTHING`,
      params: [`customer_refund_${orderNo}`, requestId, session.userId],
    },
  ]);
  const refund = await getRefund();
  if (!refund) throw createError({ statusCode: 409, statusMessage: 'Order changed. Refresh your purchases and try again.' });
  return ok({ orderNo, refundStatus: refund.status });
});
