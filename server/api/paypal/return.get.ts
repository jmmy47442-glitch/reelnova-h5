import { capturePayPalOrder, applyVerifiedCapture, type PayPalEnvironment } from '~/server/utils/paypal';
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
    const capture = await capturePayPalOrder(event, token, order.paypal_environment || undefined);
    await applyVerifiedCapture(event, token, capture);
    return sendRedirect(event, `/series/${order.series_slug}?payment=success&orderNo=${encodeURIComponent(orderNo)}`, 302);
  } catch {
    return sendRedirect(event, `/series/${order.series_slug}?payment=processing&orderNo=${encodeURIComponent(orderNo)}`, 302);
  }
});
