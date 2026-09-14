import { ok } from '~/server/utils/response';
import { d1First } from '~/server/utils/cloudflare-d1';
import { applyPayPalPaymentTerminalState, applyVerifiedCapture, applyVerifiedRefund, getPayPalOrderDetails, getPayPalRefundDetails } from '~/server/utils/paypal';
import { isCancelledPayPalOrderStatus, isTerminalCaptureFailureStatus } from '~/server/utils/paypal-payment-state';
import { recordAdminAudit } from '~/server/utils/admin-audit';
import type { PayPalEnvironment } from '~/server/utils/paypal';

interface OrderLookup { paypal_order_id: string | null; capture_id: string | null; status: string; paypal_environment: PayPalEnvironment | null }
interface RefundLookup { id: string; paypal_refund_id: string | null; status: string; amount_cents: number; currency: string; attempt_count: number; provider_request_id: string | null; provider_status: string | null }

export default defineEventHandler(async (event) => {
  const orderNo = getRouterParam(event, 'orderNo') || '';
  const actor = (event.context.adminSession as { email?: string } | undefined)?.email || 'Admin verification';
  const order = await d1First<OrderLookup>(event, 'SELECT paypal_order_id, capture_id, status, paypal_environment FROM orders WHERE order_no = ?', [orderNo]);
  if (!order) throw createError({ statusCode: 404, statusMessage: 'Order not found' });
  if (!order.paypal_order_id) throw createError({ statusCode: 409, statusMessage: 'Order has no PayPal Order ID' });
  const details = await getPayPalOrderDetails(event, order.paypal_order_id, order.paypal_environment || undefined);
  const capture = details.purchase_units?.[0]?.payments?.captures?.[0];
  if (capture?.status === 'COMPLETED') await applyVerifiedCapture(event, order.paypal_order_id, details);
  if (capture && isTerminalCaptureFailureStatus(capture.status)) {
    await applyPayPalPaymentTerminalState(event, { paypalOrderId: order.paypal_order_id, status: 'failed', note: `PayPal capture ${capture.id} failed: ${capture.status}` });
  } else if (isCancelledPayPalOrderStatus(details.status)) {
    await applyPayPalPaymentTerminalState(event, { paypalOrderId: order.paypal_order_id, status: 'cancelled', note: 'PayPal checkout was voided' });
  }
  let refundStatus: string | null = null;
  let refundVerified = false;
  if (capture && ['REFUNDED', 'REVERSED'].includes(capture.status)) {
    const applied = await applyVerifiedRefund(event, { paypalOrderId: order.paypal_order_id, captureId: capture.id, status: capture.status, source: 'admin', actor, detail: 'PayPal order verification detected refunded capture' });
    refundStatus = applied.status;
    refundVerified = true;
  }
  const refundRequest = await d1First<RefundLookup>(event, 'SELECT id, paypal_refund_id, status, amount_cents, currency, attempt_count, provider_request_id, provider_status FROM refund_requests WHERE order_no = ? ORDER BY created_at DESC LIMIT 1', [orderNo]);
  if (!refundVerified && refundRequest?.paypal_refund_id) {
    const refund = await getPayPalRefundDetails(event, refundRequest.paypal_refund_id, order.paypal_environment || undefined);
    const applied = await applyVerifiedRefund(event, { paypalRefundId: refund.id, captureId: order.capture_id, status: refund.status, source: 'admin', actor, detail: `Official refund verification: ${refund.status}` });
    refundStatus = applied.status;
    refundVerified = true;
    await recordAdminAudit(event, { module: '订单与退款', action: '核验退款状态', target: orderNo, detail: `PayPal refund ${refund.id}: ${refund.status}`, risk: '高风险' });
  } else if (!refundVerified && refundRequest) {
    // Recover a lost refund response only when this capture has one matching refund.
    const unit = details.purchase_units?.find((item) => item.payments?.captures?.length === 1 && item.payments.captures[0]?.id === order.capture_id);
    const refunds = unit?.payments?.refunds || [];
    const refund = refunds.length === 1 ? refunds[0] : undefined;
    if (refund && ['COMPLETED', 'PENDING'].includes(refund.status)
      && refund.amount?.currency_code === refundRequest.currency
      && refund.amount.value === (Number(refundRequest.amount_cents) / 100).toFixed(2)) {
      const applied = await applyVerifiedRefund(event, { paypalRefundId: refund.id, captureId: order.capture_id, status: refund.status, source: 'admin', actor, detail: `PayPal order verification recovered refund ${refund.id}: ${refund.status}` });
      refundStatus = applied.status;
      refundVerified = true;
      await recordAdminAudit(event, { module: '订单与退款', action: '核验退款状态', target: orderNo, detail: `Recovered PayPal refund ${refund.id}: ${refund.status}`, risk: '高风险' });
    }
  }
  const refundUnresolved = Boolean(refundRequest && !refundVerified && refundRequest.status !== 'completed'
    && refundRequest.provider_status !== 'REQUEST_REJECTED' && (refundRequest.attempt_count || refundRequest.provider_request_id));
  const refundReconciliationRequired = refundUnresolved || refundStatus === 'processing';
  return ok({
    paypalStatus: details.status,
    captureStatus: capture?.status || null,
    refundStatus,
    refundReconciliationRequired,
    refundAmount: refundRequest ? (Number(refundRequest.amount_cents) / 100).toFixed(2) : null,
    message: refundUnresolved ? '收款已核验，但上一笔退款结果仍未确认。请按原申请金额重试，或在 PayPal 商户后台核对退款记录。'
      : refundStatus === 'processing' ? 'PayPal 已受理退款，仍在处理中，请稍后核验。'
        : refundStatus === 'failed' || refundStatus === 'cancelled' ? 'PayPal 已确认上一笔退款失败或取消，可以修改金额重新申请。' : null,
    synchronized: !refundReconciliationRequired && (capture?.status === 'COMPLETED' || isTerminalCaptureFailureStatus(capture?.status)
      || isCancelledPayPalOrderStatus(details.status) || ['REFUNDED', 'REVERSED'].includes(capture?.status || '') || refundStatus === 'completed'),
  });
});
