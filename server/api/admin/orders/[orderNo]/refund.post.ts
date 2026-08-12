import { ok } from '~/server/utils/response';
import { d1First, d1Run } from '~/server/utils/cloudflare-d1';
import {
  applyVerifiedRefund,
  getPayPalRefundDetails,
  recordRefundEvent,
  refundPayPalCapture,
  requirePayPalConfiguration,
  type PayPalEnvironment,
} from '~/server/utils/paypal';
import { requireAdminPermission } from '~/server/utils/admin-rbac';
import { recordAdminAudit } from '~/server/utils/admin-audit';

interface RefundOrder { order_no: string; status: string; capture_id: string | null; amount_cents: number; currency: string; paypal_environment: PayPalEnvironment | null }
interface ExistingRefund { id: string; paypal_refund_id: string | null; status: string; request_source: string; attempt_count: number; provider_request_id: string | null }

const assertReason = (reason: unknown) => {
  const value = typeof reason === 'string' ? reason.trim() : '';
  if (value.length < 8 || value.length > 500) throw createError({ statusCode: 400, statusMessage: 'Refund reason must be 8-500 characters' });
  return value;
};

export default defineEventHandler(async (event) => {
  const admin = requireAdminPermission(event, 'finance.manage');
  const orderNo = getRouterParam(event, 'orderNo') || '';
  const body = await readBody<{ reason?: string; method?: 'paypal_api' | 'manual' | 'reject'; providerStatus?: string; paypalRefundId?: string }>(event);
  const reason = assertReason(body?.reason);
  const method = body?.method || 'paypal_api';
  const order = await d1First<RefundOrder>(event, 'SELECT order_no, status, capture_id, amount_cents, currency, paypal_environment FROM orders WHERE order_no = ?', [orderNo]);
  if (!order) throw createError({ statusCode: 404, statusMessage: 'Order not found' });
  if (method === 'paypal_api') await requirePayPalConfiguration(event, order.paypal_environment || undefined);
  const existing = await d1First<ExistingRefund>(event, 'SELECT id, paypal_refund_id, status, request_source, attempt_count, provider_request_id FROM refund_requests WHERE order_no = ? ORDER BY created_at DESC LIMIT 1', [orderNo]);
  if (existing?.status === 'completed' || order.status === 'refunded') return ok({ orderNo, status: 'refunded' as const, synchronized: true, refundRequestId: existing?.id });
  if (!['paid', 'refunding'].includes(order.status) && method !== 'reject') throw createError({ statusCode: 409, statusMessage: 'Only captured paid orders can be refunded' });
  if (!order.capture_id) throw createError({ statusCode: 409, statusMessage: 'Order has no PayPal Capture ID' });

  const now = new Date().toISOString();
  let requestId = existing?.id || `refund_${orderNo}`;
  if (!existing) {
    try {
      await d1Run(event, `INSERT INTO refund_requests
        (id, order_no, capture_id, amount_cents, currency, status, request_source, customer_service_result, entitlement_revoke_status, reason, requested_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, 'pending', ?, ?, ?, ?)`, [
        requestId, orderNo, order.capture_id, order.amount_cents, order.currency, method === 'paypal_api' ? 'paypal_api' : 'manual',
        method === 'reject' ? 'rejected' : 'approved', reason, admin.email, now, now,
      ]);
    } catch (error) {
      const concurrent = await d1First<{ id: string }>(event, 'SELECT id FROM refund_requests WHERE order_no = ? ORDER BY created_at DESC LIMIT 1', [orderNo]);
      if (!concurrent) throw error;
      requestId = concurrent.id;
    }
  } else {
    await d1Run(event, `UPDATE refund_requests SET status = ?, request_source = ?, customer_service_result = ?, reason = ?, requested_by = ?,
      resolution_note = ?, error_message = NULL, updated_at = ? WHERE id = ?`, [
      method === 'reject' ? 'rejected' : 'pending', method === 'paypal_api' ? 'paypal_api' : 'manual', method === 'reject' ? 'rejected' : 'approved',
      reason, admin.email, method === 'reject' ? '客服拒绝退款申请' : null, now, requestId,
    ]);
  }

  if (method === 'reject') {
    await d1Run(event, 'UPDATE refund_requests SET resolved_by = ?, resolution_note = ?, updated_at = ? WHERE id = ?', [admin.email, reason, now, requestId]);
    await recordRefundEvent(event, { refundRequestId: requestId, orderNo, eventType: 'customer_service_rejected', source: 'admin', actor: admin.email, fromStatus: existing?.status, toStatus: 'rejected', detail: reason });
    await recordAdminAudit(event, { module: '订单与退款', action: '记录退款拒绝', target: orderNo, detail: reason, risk: '高风险' });
    return ok({ orderNo, refundRequestId: requestId, status: 'rejected' as const, synchronized: false });
  }

  await recordRefundEvent(event, {
    refundRequestId: requestId,
    orderNo,
    eventType: method === 'manual' ? 'manual_result_submitted' : existing ? 'refund_retry_submitted' : 'refund_requested',
    source: 'admin',
    actor: admin.email,
    fromStatus: existing?.status,
    toStatus: 'pending',
    paypalRefundId: existing?.paypal_refund_id,
    detail: reason,
  });

  if (method === 'manual') {
    const providerStatus = String(body?.providerStatus || '').trim().toUpperCase();
    if (!['PENDING', 'COMPLETED', 'FAILED', 'CANCELLED'].includes(providerStatus)) throw createError({ statusCode: 400, statusMessage: 'Manual refund requires providerStatus PENDING, COMPLETED, FAILED or CANCELLED' });
    const applied = await applyVerifiedRefund(event, {
      paypalRefundId: body?.paypalRefundId || null,
      captureId: order.capture_id,
      status: providerStatus,
      source: 'admin',
      actor: admin.email,
      detail: `客服人工记录: ${reason}`,
    });
    await recordAdminAudit(event, { module: '订单与退款', action: '记录人工退款结果', target: orderNo, detail: `${reason}; provider=${providerStatus}; refund=${body?.paypalRefundId || 'merchant portal'}`, risk: '高风险' });
    return ok({ orderNo, refundRequestId: requestId, paypalRefundId: applied.paypalRefundId || undefined, status: applied.completed ? 'refunded' as const : applied.status === 'processing' ? 'refunding' as const : 'paid' as const, synchronized: applied.completed });
  }

  await d1Run(event, "UPDATE refund_requests SET status = 'processing', attempt_count = attempt_count + 1, provider_request_id = COALESCE(provider_request_id, ?), last_attempt_at = ?, updated_at = ?, error_message = NULL WHERE id = ?", [requestId, now, now, requestId]);
  await d1Run(event, "UPDATE orders SET status = 'refunding', note = ?, updated_at = ? WHERE order_no = ?", [`Refund requested by ${admin.email}: ${reason}`, now, orderNo]);
  let refund!: Awaited<ReturnType<typeof getPayPalRefundDetails>>;
  let applied!: Awaited<ReturnType<typeof applyVerifiedRefund>>;
  try {
    if (existing?.paypal_refund_id) {
      refund = await getPayPalRefundDetails(event, existing.paypal_refund_id, order.paypal_environment || undefined);
      if (['FAILED', 'CANCELLED', 'DENIED'].includes(refund.status.toUpperCase())) {
        const retryRequestId = `${requestId}-retry-${Number(existing.attempt_count) + 1}`;
        await recordRefundEvent(event, { refundRequestId: requestId, orderNo, eventType: 'refund_retry_requested', source: 'admin', actor: admin.email, fromStatus: existing.status, toStatus: 'processing', paypalRefundId: existing.paypal_refund_id, detail: `Retrying terminal provider status ${refund.status}` });
        await d1Run(event, 'UPDATE refund_requests SET paypal_refund_id = NULL, provider_request_id = ? WHERE id = ?', [retryRequestId, requestId]);
        refund = await refundPayPalCapture(event, { captureId: order.capture_id, requestId: retryRequestId, amount: (Number(order.amount_cents) / 100).toFixed(2), currency: order.currency, environment: order.paypal_environment || undefined });
      }
    } else {
      refund = await refundPayPalCapture(event, { captureId: order.capture_id, requestId: existing?.provider_request_id || requestId, amount: (Number(order.amount_cents) / 100).toFixed(2), currency: order.currency, environment: order.paypal_environment || undefined });
    }
    applied = await applyVerifiedRefund(event, { paypalRefundId: refund.id, captureId: order.capture_id, status: refund.status, source: 'paypal_api', actor: admin.email, detail: `PayPal API refund: ${refund.status}` });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'PayPal refund failed';
    const failedAt = new Date().toISOString();
    await d1Run(event, "UPDATE refund_requests SET status = 'failed', error_message = ?, updated_at = ? WHERE id = ?", [message, failedAt, requestId]);
    await d1Run(event, "UPDATE orders SET status = 'paid', note = ?, updated_at = ? WHERE order_no = ? AND status = 'refunding'", [`Refund failed: ${message}`, failedAt, orderNo]);
    await recordRefundEvent(event, { refundRequestId: requestId, orderNo, eventType: 'refund_attempt_failed', source: 'paypal_api', actor: admin.email, fromStatus: 'processing', toStatus: 'failed', detail: message });
    await recordAdminAudit(event, { module: '订单与退款', action: '退款失败', target: orderNo, detail: `${reason}; ${message}`, risk: '高风险' });
    throw error;
  }
  await recordAdminAudit(event, { module: '订单与退款', action: existing?.paypal_refund_id ? '同步退款结果' : '发起退款', target: orderNo, detail: `${reason}; PayPal refund ${refund.id}: ${refund.status}`, risk: '高风险' });
  return ok({ orderNo, refundRequestId: requestId, paypalRefundId: refund.id, status: applied.completed ? 'refunded' as const : 'refunding' as const, synchronized: applied.completed });
});
