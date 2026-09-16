import { reportingOrders, capturedOrders, parseReportingEnvironment } from '~/server/utils/reporting-orders';
import { ok } from '~/server/utils/response';
import { d1All } from '~/server/utils/cloudflare-d1';
import type { ReconciliationResponse } from '~/types/admin';

interface ReconciliationDbRow { date: string; currency: string; gross_cents: number; fee_cents: number; refund_cents: number; paid: number; exceptions: number }

export default defineEventHandler(async (event) => {
  const environment = parseReportingEnvironment(getQuery(event).environment);
  const days = Math.min(90, Math.max(1, Number(getQuery(event).days) || 7));
  const from = new Date(Date.now() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
  const rows = await d1All<ReconciliationDbRow>(event, `
    WITH flows AS (
      SELECT date(o.callback_at) AS date, o.currency, o.amount_cents AS gross_cents,
        o.fee_cents, 0 AS refund_cents, 1 AS paid, 0 AS exceptions
      FROM orders o WHERE ${reportingOrders('o', environment)} AND ${capturedOrders()}
        AND date(o.callback_at) >= ?
      UNION ALL
      SELECT date(r.completed_at), r.currency, 0, 0, r.amount_cents, 0, 0
      FROM refund_requests r JOIN orders o ON o.order_no = r.order_no
      WHERE ${reportingOrders('o', environment)} AND ${capturedOrders()}
        AND r.status = 'completed' AND date(r.completed_at) >= ?
      UNION ALL
      SELECT date(o.created_at), o.currency, 0, 0, 0, 0, 1
      FROM orders o WHERE ${reportingOrders('o', environment)}
        AND o.status IN ('failed', 'risk_review') AND date(o.created_at) >= ?
    )
    SELECT date, currency, SUM(gross_cents) AS gross_cents, SUM(fee_cents) AS fee_cents,
      SUM(refund_cents) AS refund_cents, SUM(paid) AS paid, SUM(exceptions) AS exceptions
    FROM flows GROUP BY date, currency ORDER BY date ASC
  `, [from, from, from]);
  const data: ReconciliationResponse = {
    connected: true, generatedAt: new Date().toISOString(), rows: rows.map((row) => ({
      date: row.date, currency: row.currency, gross: Number(row.gross_cents) / 100, fee: Number(row.fee_cents) / 100,
      refunds: Number(row.refund_cents) / 100, net: (Number(row.gross_cents) - Number(row.fee_cents) - Number(row.refund_cents)) / 100,
      paid: Number(row.paid), exceptions: Number(row.exceptions),
    })),
  };
  return ok(data);
});
