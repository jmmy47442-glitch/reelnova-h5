import { ok } from '~/server/utils/response';
import { d1All, d1Run } from '~/server/utils/cloudflare-d1';
import { getUserSession } from '~/server/utils/user-auth';

export default defineEventHandler(async (event) => {
  const session = await getUserSession(event);
  if (!session) throw createError({ statusCode: 401, statusMessage: 'Login required to restore purchases', data: { code: 'AUTH_REQUIRED' } });
  const body = await readBody<{ lookup?: string }>(event);
  const lookup = body.lookup?.trim() || '';
  if (!lookup) throw createError({ statusCode: 400, statusMessage: 'Order number or PayPal transaction ID is required' });
  const isOrderNumber = /^RN-[A-Z0-9-]+$/i.test(lookup);
  const rows = await d1All<{ order_no: string; user_id: string; series_id: string; series_title: string }>(event,
    isOrderNumber
      ? `SELECT order_no, user_id, series_id, series_title FROM orders WHERE upper(order_no) = upper(?) AND status = 'paid' AND (user_id = ? OR lower(email) = lower(?))`
      : `SELECT order_no, user_id, series_id, series_title FROM orders WHERE status = 'paid' AND (paypal_order_id = ? OR capture_id = ?) AND (user_id = ? OR lower(email) = lower(?))`,
    isOrderNumber ? [lookup, session.userId, session.email] : [lookup, lookup, session.userId, session.email]);
  if (!rows.length) throw createError({ statusCode: 404, statusMessage: 'No verified paid order matched this account', data: { code: 'ORDER_NOT_FOUND' } });
  const now = new Date().toISOString();
  for (const row of rows) {
    await d1Run(event, `INSERT INTO entitlements (id, user_id, series_id, order_no, status, granted_at)
      VALUES (?, ?, ?, ?, 'granted', ?) ON CONFLICT(user_id, series_id) DO UPDATE SET order_no = excluded.order_no, status = 'granted', granted_at = excluded.granted_at, revoked_at = NULL`,
    [crypto.randomUUID(), session.userId, row.series_id, row.order_no, now]);
  }
  return ok({ restored: rows.length, series: rows.map((row) => ({ seriesId: row.series_id, title: row.series_title, orderNo: row.order_no })) });
});
