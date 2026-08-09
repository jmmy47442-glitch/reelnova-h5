import { ok } from '~/server/utils/response';
import { d1All } from '~/server/utils/cloudflare-d1';
import type { ReconciliationResponse } from '~/types/admin';

interface ReconciliationDbRow { date: string; currency: string; gross_cents: number; fee_cents: number; refund_cents: number; paid: number; exceptions: number }

export default defineEventHandler(async (event) => {
  const days = Math.min(90, Math.max(1, Number(getQuery(event).days) || 7));
  const from = new Date(Date.now() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
  const rows = await d1All<ReconciliationDbRow>(event, `
    SELECT date(created_at) AS date, currency,
      SUM(CASE WHEN status = 'paid' THEN amount_cents ELSE 0 END) AS gross_cents,
      SUM(CASE WHEN status = 'paid' THEN fee_cents ELSE 0 END) AS fee_cents,
      SUM(CASE WHEN status = 'refunded' THEN amount_cents ELSE 0 END) AS refund_cents,
      SUM(CASE WHEN status = 'paid' THEN 1 ELSE 0 END) AS paid,
      SUM(CASE WHEN status IN ('failed', 'risk_review') THEN 1 ELSE 0 END) AS exceptions
    FROM orders WHERE date(created_at) >= ? GROUP BY date(created_at), currency ORDER BY date ASC
  `, [from]);
  const data: ReconciliationResponse = {
    connected: true, generatedAt: new Date().toISOString(), rows: rows.map((row) => ({
      date: row.date, currency: row.currency, gross: Number(row.gross_cents) / 100, fee: Number(row.fee_cents) / 100,
      refunds: Number(row.refund_cents) / 100, net: (Number(row.gross_cents) - Number(row.fee_cents) - Number(row.refund_cents)) / 100,
      paid: Number(row.paid), exceptions: Number(row.exceptions),
    })),
  };
  return ok(data);
});
