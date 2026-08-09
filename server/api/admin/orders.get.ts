import { ok } from '~/server/utils/response';
import { d1All, d1First } from '~/server/utils/cloudflare-d1';
import type { AdminOrdersResponse, PersistedOrder } from '~/types/admin';

interface OrderRow {
  order_no: string; series_id: string; series_title: string; email: string | null; country: string | null;
  amount_cents: number; fee_cents: number; status: PersistedOrder['status']; paypal_order_id: string | null;
  capture_id: string | null; created_at: string; callback_at: string | null; note: string | null; entitlement_status: string | null;
}
interface CountRow { value: number }

const mapOrder = (row: OrderRow): PersistedOrder => ({
  orderNo: row.order_no, seriesId: row.series_id, seriesTitle: row.series_title, email: row.email, country: row.country,
  amount: Number(row.amount_cents) / 100, currency: 'USD', fee: Number(row.fee_cents) / 100,
  netAmount: (Number(row.amount_cents) - Number(row.fee_cents)) / 100, status: row.status,
  paypalOrderId: row.paypal_order_id, captureId: row.capture_id, createdAt: row.created_at, callbackAt: row.callback_at,
  entitlement: row.entitlement_status === 'granted' ? 'granted' : row.entitlement_status === 'revoked' ? 'revoked' : 'pending', note: row.note,
});

export default defineEventHandler(async (event) => {
  const query = getQuery(event);
  const page = Math.max(1, Number(query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(query.pageSize) || 20));
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (query.status) { conditions.push('o.status = ?'); params.push(String(query.status)); }
  if (query.country) { conditions.push('o.country = ?'); params.push(String(query.country)); }
  if (query.from) { conditions.push('o.created_at >= ?'); params.push(String(query.from)); }
  if (query.to) { conditions.push('o.created_at <= ?'); params.push(String(query.to)); }
  if (query.keyword) {
    conditions.push('(o.order_no LIKE ? OR o.series_title LIKE ? OR o.email LIKE ? OR o.paypal_order_id LIKE ?)');
    const keyword = `%${String(query.keyword).replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
    params.push(keyword, keyword, keyword, keyword);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const today = new Date();
  const todayIso = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())).toISOString();
  const [rows, total, todayOrders, paidAmount, pending, exceptions] = await Promise.all([
    d1All<OrderRow>(event, `SELECT o.*, e.status AS entitlement_status FROM orders o LEFT JOIN entitlements e ON e.order_no = o.order_no ${where} ORDER BY o.created_at DESC LIMIT ? OFFSET ?`, [...params, pageSize, (page - 1) * pageSize]),
    d1First<CountRow>(event, `SELECT COUNT(*) AS value FROM orders o ${where}`, params),
    d1First<CountRow>(event, 'SELECT COUNT(*) AS value FROM orders WHERE created_at >= ?', [todayIso]),
    d1First<CountRow>(event, "SELECT COALESCE(SUM(amount_cents), 0) AS value FROM orders WHERE status = 'paid' AND callback_at >= ?", [todayIso]),
    d1First<CountRow>(event, "SELECT COUNT(*) AS value FROM orders WHERE status IN ('pending', 'processing', 'refunding')"),
    d1First<CountRow>(event, "SELECT COUNT(*) AS value FROM orders WHERE status IN ('failed', 'risk_review')"),
  ]);
  const data: AdminOrdersResponse = {
    connected: true, generatedAt: new Date().toISOString(), items: rows.map(mapOrder), total: Number(total?.value || 0),
    summary: { todayOrders: Number(todayOrders?.value || 0), paidAmount: Number(paidAmount?.value || 0) / 100, pending: Number(pending?.value || 0), exceptions: Number(exceptions?.value || 0) },
  };
  return ok(data);
});
