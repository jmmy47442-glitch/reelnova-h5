import { reportingOrders, capturedOrders } from './reporting-orders';
import type { Series } from '~/types/content';
import type { H3Event } from 'h3';
import { d1All, hasD1Connection } from './cloudflare-d1';

export interface SeriesBusinessMetrics {
  purchases: number;
  revenueCents: number;
}

interface BusinessMetricRow {
  series_id: string;
  purchases: number;
  revenue_cents: number;
}

const metricsCacheTtlMs = 5_000;
let metricsCache: { expiresAt: number; value: Map<string, SeriesBusinessMetrics> } | undefined;

export const getSeriesBusinessMetrics = async (event: H3Event) => {
  if (!hasD1Connection(event)) return new Map<string, SeriesBusinessMetrics>();
  if (metricsCache && metricsCache.expiresAt > Date.now()) return new Map(metricsCache.value);

  const rows = await d1All<BusinessMetricRow>(event, `
    SELECT series_id, COUNT(*) AS purchases, COALESCE(SUM(o.amount_cents - COALESCE((SELECT SUM(r.amount_cents) FROM refund_requests r WHERE r.order_no = o.order_no AND r.status = 'completed'), 0)), 0) AS revenue_cents
    FROM orders o
    WHERE ${reportingOrders()} AND ${capturedOrders()}
    GROUP BY series_id`);
  const value = new Map(rows.map((row) => [row.series_id, {
    purchases: Number(row.purchases || 0),
    revenueCents: Number(row.revenue_cents || 0),
  }]));
  metricsCache = { value, expiresAt: Date.now() + metricsCacheTtlMs };
  return new Map(value);
};

/** Rank using persisted playback starts; deterministic ties do not invent heat. */
export const sortSeriesByPopularity = <T extends Pick<Series, 'id' | 'views' | 'updatedAt'>>(items: T[]): T[] =>
  [...items].sort((a, b) => b.views - a.views
    || String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''))
    || a.id.localeCompare(b.id));
