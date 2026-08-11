import { ok } from '~/server/utils/response';
import { d1First } from '~/server/utils/cloudflare-d1';
import { applyVerifiedCapture, applyVerifiedRefund, getPayPalOrderDetails, getPayPalRefundDetails } from '~/server/utils/paypal';
import { recordAdminAudit } from '~/server/utils/admin-audit';

interface OrderLookup { paypal_order_id: string | null; capture_id: string | null; status: string }
interface RefundLookup { id: string; paypal_refund_id: string | null; status: string }

export default defineEventHandler(async (event) => {
  const orderNo = getRouterParam(event, 'orderNo') || '';
  const actor = (event.context.adminSession as { email?: string } | undefined)?.email || 'Admin verification';
  const order = await d1First<OrderLookup>(event, 'SELECT paypal_order_id, capture_id, status FROM orders WHERE order_no = ?', [orderNo]);
  if (!order) throw createError({ statusCode: 404, statusMessage: 'Order not found' });
  if (!order.paypal_order_id) throw createError({ statusCode: 409, statusMessage: 'Order has no PayPal Order ID' });
  const details = await getPayPalOrderDetails(event, order.paypal_order_id);
  const capture = details.purchase_units?.[0]?.payments?.captures?.[0];
  if (capture?.status === 'COMPLETED') await applyVerifiedCapture(event, order.paypal_order_id, details);
  if (capture && ['REFUNDED', 'REVERSED'].includes(capture.status)) {
    await applyVerifiedRefund(event, { paypalOrderId: order.paypal_order_id, captureId: capture.id, status: capture.status, source: 'admin', actor, detail: 'PayPal order verification detected refunded capture' });
  }

  const refundRequest = await d1First<RefundLookup>(event, "SELECT id, paypal_refund_id, status FROM refund_requests WHERE order_no = ? AND status NOT IN ('completed', 'rejected') ORDER BY created_at DESC LIMIT 1", [orderNo]);
  let refundStatus: string | null = null;
  if (refundRequest?.paypal_refund_id) {
    const refund = await getPayPalRefundDetails(event, refundRequest.paypal_refund_id);
    const applied = await applyVerifiedRefund(event, { paypalRefundId: refund.id, captureId: order.capture_id, status: refund.status, source: 'admin', actor, detail: `Official refund verification: ${refund.status}` });
    refundStatus = applied.status;
    await recordAdminAudit(event, { module: '订单与退款', action: '核验退款状态', target: orderNo, detail: `PayPal refund ${refund.id}: ${refund.status}`, risk: '高风险' });
  }
  return ok({
    paypalStatus: details.status,
    captureStatus: capture?.status || null,
    refundStatus,
    synchronized: capture?.status === 'COMPLETED' || ['REFUNDED', 'REVERSED'].includes(capture?.status || '') || refundStatus === 'completed',
  });
});
