import { ok } from '~/server/utils/response';
import { d1All } from '~/server/utils/cloudflare-d1';
import { applyVerifiedCapture, getPayPalOrderDetails, type PayPalEnvironment } from '~/server/utils/paypal';
import { getUserSession } from '~/server/utils/user-auth';

export default defineEventHandler(async (event) => {
  const session = await getUserSession(event);
  if (!session) throw createError({ statusCode: 401, statusMessage: 'Login required to restore purchases', data: { code: 'AUTH_REQUIRED' } });
  const body = await readBody<{ lookup?: string }>(event);
  const lookup = body.lookup?.trim() || '';
  if (!lookup) throw createError({ statusCode: 400, statusMessage: 'Order number or PayPal transaction ID is required' });
  const isOrderNumber = /^RN-[A-Z0-9-]+$/i.test(lookup);
  const rows = await d1All<{
    order_no: string;
    user_id: string;
    series_id: string;
    series_title: string;
    paypal_order_id: string | null;
    paypal_environment: PayPalEnvironment | null;
  }>(event,
    isOrderNumber
      ? `SELECT order_no, user_id, series_id, series_title, paypal_order_id, paypal_environment FROM orders WHERE upper(order_no) = upper(?) AND status = 'paid' AND (user_id = ? OR lower(email) = lower(?))`
      : `SELECT order_no, user_id, series_id, series_title, paypal_order_id, paypal_environment FROM orders WHERE status = 'paid' AND (paypal_order_id = ? OR capture_id = ?) AND (user_id = ? OR lower(email) = lower(?))`,
    isOrderNumber ? [lookup, session.userId, session.email] : [lookup, lookup, session.userId, session.email]);
  if (!rows.length) throw createError({ statusCode: 404, statusMessage: 'No verified paid order matched this account', data: { code: 'ORDER_NOT_FOUND' } });
  for (const row of rows) {
    if (!row.paypal_order_id) throw createError({ statusCode: 409, statusMessage: 'Paid order has no PayPal order ID', data: { code: 'ORDER_PAYMENT_REFERENCE_MISSING', orderNo: row.order_no } });
    const paypalOrder = await getPayPalOrderDetails(event, row.paypal_order_id, row.paypal_environment || undefined);
    await applyVerifiedCapture(event, row.paypal_order_id, paypalOrder);
  }
  return ok({ restored: rows.length, series: rows.map((row) => ({ seriesId: row.series_id, title: row.series_title, orderNo: row.order_no })) });
});
