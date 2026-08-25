import { d1First } from '~/server/utils/cloudflare-d1';
import { applyPayPalPaymentTerminalState } from '~/server/utils/paypal';

export default defineEventHandler(async (event) => {
  const query = getQuery(event);
  const orderNo = String(query.orderNo || '');
  const token = String(query.token || '');
  const order = await d1First<{ paypal_order_id: string | null; series_slug: string; status: string }>(event,
    'SELECT paypal_order_id, series_slug, status FROM orders WHERE order_no = ?', [orderNo]);
  if (!order || !token || order.paypal_order_id !== token) throw createError({ statusCode: 400, statusMessage: 'Invalid PayPal cancellation' });
  if (['pending', 'processing'].includes(order.status)) {
    await applyPayPalPaymentTerminalState(event, { paypalOrderId: token, status: 'cancelled', note: 'Payment cancelled by user on PayPal' });
  }
  return sendRedirect(event, `/series/${order.series_slug}?payment=cancelled&orderNo=${encodeURIComponent(orderNo)}`, 302);
});
