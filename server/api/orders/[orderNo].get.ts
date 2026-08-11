import { ok } from '~/server/utils/response';
import { d1First } from '~/server/utils/cloudflare-d1';
import { getUserSession } from '~/server/utils/user-auth';
import type { Order, OrderStatus } from '~/types/content';

interface OrderRow { order_no: string; series_id: string; series_title: string; amount_cents: number; currency: 'USD'; status: OrderStatus; created_at: string; paypal_order_id: string | null; refund_status: Order['refundStatus'] | null; entitlement_status: Order['entitlementStatus'] | null }

export default defineEventHandler(async (event) => {
  const userSession = await getUserSession(event);
  if (!userSession) throw createError({ statusCode: 401, statusMessage: 'Login required' });
  const orderNo = getRouterParam(event, 'orderNo') || '';
  const row = await d1First<OrderRow>(event, `SELECT o.order_no, o.series_id, o.series_title, o.amount_cents, o.currency, o.status, o.created_at, o.paypal_order_id,
    (SELECT rr.status FROM refund_requests rr WHERE rr.order_no = o.order_no ORDER BY rr.created_at DESC LIMIT 1) AS refund_status,
    (SELECT e.status FROM entitlements e WHERE e.order_no = o.order_no LIMIT 1) AS entitlement_status
    FROM orders o WHERE o.order_no = ? AND o.user_id = ?`, [orderNo, userSession.userId]);
  if (!row) throw createError({ statusCode: 404, statusMessage: 'Order not found' });
  const order: Order = { orderNo: row.order_no, seriesId: row.series_id, seriesTitle: row.series_title, amount: Number(row.amount_cents) / 100, currency: row.currency, status: row.status, refundStatus: row.refund_status || undefined, entitlementStatus: row.entitlement_status || 'pending', createdAt: row.created_at, paypalOrderId: row.paypal_order_id || undefined };
  return ok(order);
});
