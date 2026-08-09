import { ok } from '~/server/utils/response';
import { d1First, getVisitorId } from '~/server/utils/cloudflare-d1';
import type { Order, OrderStatus } from '~/types/content';

interface OrderRow { order_no: string; series_id: string; series_title: string; amount_cents: number; currency: 'USD'; status: OrderStatus; created_at: string; paypal_order_id: string | null }

export default defineEventHandler(async (event) => {
  const orderNo = getRouterParam(event, 'orderNo') || '';
  const row = await d1First<OrderRow>(event, 'SELECT order_no, series_id, series_title, amount_cents, currency, status, created_at, paypal_order_id FROM orders WHERE order_no = ? AND visitor_id = ?', [orderNo, getVisitorId(event)]);
  if (!row) throw createError({ statusCode: 404, statusMessage: 'Order not found' });
  const order: Order = { orderNo: row.order_no, seriesId: row.series_id, seriesTitle: row.series_title, amount: Number(row.amount_cents) / 100, currency: row.currency, status: row.status, createdAt: row.created_at, paypalOrderId: row.paypal_order_id || undefined };
  return ok(order);
});
