import { ok } from '~/server/utils/response';
import { d1First, d1Run } from '~/server/utils/cloudflare-d1';
import { applyVerifiedRefund, refundPayPalCapture, requirePayPalConfiguration } from '~/server/utils/paypal';
import { requireSuperAdmin } from '~/server/utils/admin-auth';
import { recordAdminAudit } from '~/server/utils/admin-audit';

interface RefundOrder { order_no: string; status: string; capture_id: string | null; amount_cents: number; currency: string }

export default defineEventHandler(async (event) => {
  const admin = requireSuperAdmin(event);
  const orderNo = getRouterParam(event, 'orderNo') || '';
  const body = await readBody<{ reason?: string }>(event);
  const reason = body?.reason?.trim() || '';
  if (reason.length < 8 || reason.length > 500) throw createError({ statusCode: 400, statusMessage: 'Refund reason must be 8-500 characters' });
  requirePayPalConfiguration(event);
  const order = await d1First<RefundOrder>(event, 'SELECT order_no, status, capture_id, amount_cents, currency FROM orders WHERE order_no = ?', [orderNo]);
  if (!order) throw createError({ statusCode: 404, statusMessage: 'Order not found' });
  if (order.status === 'refunded') return ok({ orderNo, status: 'refunded' as const, synchronized: true });
  if (!['paid', 'refunding'].includes(order.status) || !order.capture_id) throw createError({ statusCode: 409, statusMessage: 'Only captured paid orders can be refunded' });
  const existing = await d1First<{ id: string; paypal_refund_id: string | null; status: string }>(event,
    'SELECT id, paypal_refund_id, status FROM refund_requests WHERE order_no = ? ORDER BY created_at DESC LIMIT 1', [orderNo]);
  if (existing?.status === 'completed') return ok({ orderNo, status: 'refunded' as const, synchronized: true });
  if (existing?.status === 'processing') return ok({ orderNo, status: 'refunding' as const, synchronized: false });
  const now = new Date().toISOString();
  const requestId = existing?.id || `refund_${crypto.randomUUID()}`;
  if (!existing) await d1Run(event, `INSERT INTO refund_requests
    (id, order_no, capture_id, amount_cents, currency, status, reason, requested_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'USD', 'pending', ?, ?, ?, ?)`, [requestId, orderNo, order.capture_id, order.amount_cents, reason, admin.email, now, now]);
  else await d1Run(event, "UPDATE refund_requests SET status = 'pending', reason = ?, requested_by = ?, error_message = NULL, updated_at = ? WHERE id = ?", [reason, admin.email, now, requestId]);
  await d1Run(event, "UPDATE orders SET status = 'refunding', note = ?, updated_at = ? WHERE order_no = ?", [`Refund requested by ${admin.email}: ${reason}`, now, orderNo]);
  try {
    const refund = await refundPayPalCapture(event, { captureId: order.capture_id, requestId, amount: (Number(order.amount_cents) / 100).toFixed(2) });
    const applied = await applyVerifiedRefund(event, { paypalRefundId: refund.id, captureId: order.capture_id, status: refund.status });
    await recordAdminAudit(event, { module: '订单与退款', action: '发起退款', target: orderNo, detail: `${reason}; PayPal refund ${refund.id}: ${refund.status}`, risk: '高风险' });
    return ok({ orderNo, paypalRefundId: refund.id, status: applied.completed ? 'refunded' as const : 'refunding' as const, synchronized: applied.completed });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'PayPal refund failed';
    await d1Run(event, "UPDATE refund_requests SET status = 'failed', error_message = ?, updated_at = ? WHERE id = ?", [message, new Date().toISOString(), requestId]);
    await d1Run(event, "UPDATE orders SET status = 'paid', note = ?, updated_at = ? WHERE order_no = ? AND status = 'refunding'", [`Refund failed: ${message}`, new Date().toISOString(), orderNo]);
    await recordAdminAudit(event, { module: '订单与退款', action: '退款失败', target: orderNo, detail: `${reason}; ${message}`, risk: '高风险' });
    throw error;
  }
});
