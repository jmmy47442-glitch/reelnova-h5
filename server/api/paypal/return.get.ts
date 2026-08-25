import { applyPayPalPaymentTerminalState, reconcilePayPalOrder, type PayPalEnvironment } from '~/server/utils/paypal';
import { isDefinitiveCaptureFailure } from '~/server/utils/paypal-payment-state';
import { d1First } from '~/server/utils/cloudflare-d1';
import type { OrderStatus } from '~/types/content';

interface ReturnOrder { paypal_order_id: string; series_slug: string; status: OrderStatus; paypal_environment: PayPalEnvironment | null }

export default defineEventHandler(async (event) => {
  const query = getQuery(event);
  const orderNo = String(query.orderNo || '');
  const token = String(query.token || '');
  const order = await d1First<ReturnOrder>(event, 'SELECT paypal_order_id, series_slug, status, paypal_environment FROM orders WHERE order_no = ?', [orderNo]);
  if (!order || !token || order.paypal_order_id !== token) throw createError({ statusCode: 400, statusMessage: 'Invalid PayPal return' });
  if (order.status === 'paid') {
    return sendRedirect(event, `/series/${order.series_slug}?payment=success&orderNo=${encodeURIComponent(orderNo)}`, 302);
  }
  if (!['pending', 'processing'].includes(order.status)) {
    return sendRedirect(event, `/series/${order.series_slug}?payment=cancelled&orderNo=${encodeURIComponent(orderNo)}`, 302);
  }
  try {
    const status = await reconcilePayPalOrder(event, {
      paypalOrderId: token,
      environment: order.paypal_environment || undefined,
      captureApproved: true,
    });
    return sendRedirect(event, `/series/${order.series_slug}?payment=${status === 'paid' ? 'success' : status}&orderNo=${encodeURIComponent(orderNo)}`, 302);
  } catch (error) {
    if (isDefinitiveCaptureFailure(error)) {
      await applyPayPalPaymentTerminalState(event, { paypalOrderId: token, status: 'failed', note: 'PayPal declined the capture request' });
      return sendRedirect(event, `/series/${order.series_slug}?payment=failed&orderNo=${encodeURIComponent(orderNo)}`, 302);
    }
    return sendRedirect(event, `/series/${order.series_slug}?payment=processing&orderNo=${encodeURIComponent(orderNo)}`, 302);
  }
});
