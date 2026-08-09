import { ok } from '~/server/utils/response';
import { d1All, d1First } from '~/server/utils/cloudflare-d1';
import type { DashboardMetric, DashboardSummary, DashboardTrendPoint } from '~/types/admin';

interface CountRow { value: number }
interface MoneyRow { value: number }
interface HealthRow { last_webhook_at: string | null; failed_webhooks: number }
interface TopSeriesRow { series_id: string; title: string; plays: number; paid_orders: number; revenue_cents: number }

const percentChange = (current: number, previous: number) => previous === 0 ? (current === 0 ? 0 : null) : Number((((current - previous) / previous) * 100).toFixed(1));
const metric = (value: number, previousValue: number): DashboardMetric => ({ value, previousValue, changePercent: percentChange(value, previousValue) });

export default defineEventHandler(async (event) => {
  const now = new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const yesterday = new Date(today.getTime() - 86_400_000);
  const fourteenDaysAgo = new Date(today.getTime() - 13 * 86_400_000);
  const todayIso = today.toISOString();
  const yesterdayIso = yesterday.toISOString();

  const [playsToday, playsYesterday, ordersToday, ordersYesterday, revenueToday, revenueYesterday, exceptionsToday, exceptionsYesterday, trendRows, topRows, health, pendingOrders] = await Promise.all([
    d1First<CountRow>(event, "SELECT COUNT(*) AS value FROM playback_events WHERE event_type = 'start' AND created_at >= ?", [todayIso]),
    d1First<CountRow>(event, "SELECT COUNT(*) AS value FROM playback_events WHERE event_type = 'start' AND created_at >= ? AND created_at < ?", [yesterdayIso, todayIso]),
    d1First<CountRow>(event, 'SELECT COUNT(*) AS value FROM orders WHERE created_at >= ?', [todayIso]),
    d1First<CountRow>(event, 'SELECT COUNT(*) AS value FROM orders WHERE created_at >= ? AND created_at < ?', [yesterdayIso, todayIso]),
    d1First<MoneyRow>(event, "SELECT COALESCE(SUM(amount_cents), 0) AS value FROM orders WHERE status = 'paid' AND callback_at >= ?", [todayIso]),
    d1First<MoneyRow>(event, "SELECT COALESCE(SUM(amount_cents), 0) AS value FROM orders WHERE status = 'paid' AND callback_at >= ? AND callback_at < ?", [yesterdayIso, todayIso]),
    d1First<CountRow>(event, "SELECT COUNT(*) AS value FROM orders WHERE status IN ('failed', 'risk_review') AND created_at >= ?", [todayIso]),
    d1First<CountRow>(event, "SELECT COUNT(*) AS value FROM orders WHERE status IN ('failed', 'risk_review') AND created_at >= ? AND created_at < ?", [yesterdayIso, todayIso]),
    d1All<{ date: string; plays: number; revenue_cents: number }>(event, `
      WITH dates AS (
        SELECT date(created_at) AS date FROM playback_events WHERE created_at >= ?
        UNION SELECT date(created_at) AS date FROM orders WHERE created_at >= ?
      ), plays AS (
        SELECT date(created_at) AS date, COUNT(*) AS plays FROM playback_events WHERE event_type = 'start' AND created_at >= ? GROUP BY date(created_at)
      ), revenue AS (
        SELECT date(callback_at) AS date, SUM(amount_cents) AS revenue_cents FROM orders WHERE status = 'paid' AND callback_at >= ? GROUP BY date(callback_at)
      )
      SELECT dates.date, COALESCE(plays.plays, 0) AS plays, COALESCE(revenue.revenue_cents, 0) AS revenue_cents
      FROM dates LEFT JOIN plays USING(date) LEFT JOIN revenue USING(date) ORDER BY dates.date ASC
    `, [fourteenDaysAgo.toISOString(), fourteenDaysAgo.toISOString(), fourteenDaysAgo.toISOString(), fourteenDaysAgo.toISOString()]),
    d1All<TopSeriesRow>(event, `
      WITH plays AS (
        SELECT series_id, MAX(series_title) AS title, COUNT(*) AS plays FROM playback_events
        WHERE event_type = 'start' AND created_at >= ? GROUP BY series_id
      ), sales AS (
        SELECT series_id, MAX(series_title) AS title, COUNT(*) AS paid_orders, COALESCE(SUM(amount_cents), 0) AS revenue_cents
        FROM orders WHERE status = 'paid' AND callback_at >= ? GROUP BY series_id
      ), ids AS (SELECT series_id FROM plays UNION SELECT series_id FROM sales)
      SELECT ids.series_id, COALESCE(plays.title, sales.title) AS title, COALESCE(plays.plays, 0) AS plays,
        COALESCE(sales.paid_orders, 0) AS paid_orders, COALESCE(sales.revenue_cents, 0) AS revenue_cents
      FROM ids LEFT JOIN plays USING(series_id) LEFT JOIN sales USING(series_id)
      ORDER BY revenue_cents DESC, plays DESC LIMIT 10
    `, [new Date(today.getTime() - 6 * 86_400_000).toISOString(), new Date(today.getTime() - 6 * 86_400_000).toISOString()]),
    d1First<HealthRow>(event, `SELECT MAX(received_at) AS last_webhook_at,
      SUM(CASE WHEN processing_status = 'failed' THEN 1 ELSE 0 END) AS failed_webhooks FROM paypal_webhook_events`),
    d1First<CountRow>(event, "SELECT COUNT(*) AS value FROM orders WHERE status IN ('pending', 'processing', 'refunding')"),
  ]);

  const trendByDate = new Map(trendRows.map((row) => [row.date, row]));
  const trends: DashboardTrendPoint[] = Array.from({ length: 14 }, (_, index) => {
    const date = new Date(fourteenDaysAgo.getTime() + index * 86_400_000).toISOString().slice(0, 10);
    const row = trendByDate.get(date);
    return { date, plays: Number(row?.plays || 0), revenue: Number(row?.revenue_cents || 0) / 100 };
  });

  const data: DashboardSummary = {
    connected: true,
    source: 'Cloudflare D1',
    generatedAt: now.toISOString(),
    timezone: 'UTC',
    metrics: {
      plays: metric(Number(playsToday?.value || 0), Number(playsYesterday?.value || 0)),
      orders: metric(Number(ordersToday?.value || 0), Number(ordersYesterday?.value || 0)),
      revenue: metric(Number(revenueToday?.value || 0) / 100, Number(revenueYesterday?.value || 0) / 100),
      exceptions: metric(Number(exceptionsToday?.value || 0), Number(exceptionsYesterday?.value || 0)),
    },
    trends,
    topSeries: topRows.map((row) => ({
      seriesId: row.series_id,
      title: row.title,
      plays: Number(row.plays),
      paidOrders: Number(row.paid_orders),
      revenue: Number(row.revenue_cents) / 100,
      conversion: Number(row.plays) ? Number(((Number(row.paid_orders) / Number(row.plays)) * 100).toFixed(2)) : 0,
    })),
    health: { database: 'ok', lastWebhookAt: health?.last_webhook_at || null, pendingOrders: Number(pendingOrders?.value || 0), failedWebhooks: Number(health?.failed_webhooks || 0) },
  };
  return ok(data);
});
