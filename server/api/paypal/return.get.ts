import { capturePayPalOrder, applyVerifiedCapture } from '~/server/utils/paypal';
import { d1First } from '~/server/utils/cloudflare-d1';

interface ReturnOrder { paypal_order_id: string; series_slug: string }

export default defineEventHandler(async (event) => {
  const query = getQuery(event);
  const orderNo = String(query.orderNo || '');
  const token = String(query.token || '');
  const order = await d1First<ReturnOrder>(event, 'SELECT paypal_order_id, series_slug FROM orders WHERE order_no = ?', [orderNo]);
  if (!order || !token || order.paypal_order_id !== token) throw createError({ statusCode: 400, statusMessage: 'Invalid PayPal return' });
  try {
    const capture = await capturePayPalOrder(event, token);
    await applyVerifiedCapture(event, token, capture);
    return sendRedirect(event, `/series/${order.series_slug}?payment=success&orderNo=${encodeURIComponent(orderNo)}`, 302);
  } catch {
    return sendRedirect(event, `/series/${order.series_slug}?payment=processing&orderNo=${encodeURIComponent(orderNo)}`, 302);
  }
});
