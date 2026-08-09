import { ok } from '~/server/utils/response';
import { d1First } from '~/server/utils/cloudflare-d1';
import { applyVerifiedCapture, getPayPalOrderDetails } from '~/server/utils/paypal';

interface OrderLookup { paypal_order_id: string | null; status: string }

export default defineEventHandler(async (event) => {
  const orderNo = getRouterParam(event, 'orderNo') || '';
  const order = await d1First<OrderLookup>(event, 'SELECT paypal_order_id, status FROM orders WHERE order_no = ?', [orderNo]);
  if (!order) throw createError({ statusCode: 404, statusMessage: 'Order not found' });
  if (!order.paypal_order_id) throw createError({ statusCode: 409, statusMessage: 'Order has no PayPal Order ID' });
  const details = await getPayPalOrderDetails(event, order.paypal_order_id);
  const capture = details.purchase_units?.[0]?.payments?.captures?.[0];
  if (capture?.status === 'COMPLETED') await applyVerifiedCapture(event, order.paypal_order_id, details);
  return ok({ paypalStatus: details.status, captureStatus: capture?.status || null, synchronized: capture?.status === 'COMPLETED' });
});
