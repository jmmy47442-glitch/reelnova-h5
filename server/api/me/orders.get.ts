import { ok } from '~/server/utils/response';
import { d1All } from '~/server/utils/cloudflare-d1';
import { getUserSession } from '~/server/utils/user-auth';
import type { Order, OrderStatus } from '~/types/content';

interface OrderRow {
  order_no: string;
  series_id: string;
  series_title: string;
  amount_cents: number;
  currency: 'USD';
  status: OrderStatus;
  created_at: string;
  paypal_order_id: string | null;
}

export default defineEventHandler(async (event) => {
  const userSession = await getUserSession(event);
  if (!userSession) throw createError({ statusCode: 401, statusMessage: 'Login required' });

  const rows = await d1All<OrderRow>(event, `
    SELECT order_no, series_id, series_title, amount_cents, currency, status, created_at, paypal_order_id
    FROM orders
    WHERE user_id = ?
    ORDER BY created_at DESC
  `, [userSession.userId]);

  const orders: Order[] = rows.map((row) => ({
    orderNo: row.order_no,
    seriesId: row.series_id,
    seriesTitle: row.series_title,
    amount: Number(row.amount_cents) / 100,
    currency: row.currency,
    status: row.status,
    createdAt: row.created_at,
    paypalOrderId: row.paypal_order_id || undefined,
  }));

  return ok(orders);
});
