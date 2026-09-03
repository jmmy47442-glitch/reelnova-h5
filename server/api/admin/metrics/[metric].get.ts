import { ok } from '~/server/utils/response';
import { d1All, d1First } from '~/server/utils/cloudflare-d1';
import type {
  AdminMetricDetailResponse,
  AdminMetricOrderItem,
  AdminMetricPlaybackItem,
  DashboardMetricKey,
  PersistedOrderStatus,
} from '~/types/admin';

interface CountRow { value: number; amount_cents?: number }

interface PlaybackRow {
  event_id: string;
  session_id: string;
  user_id: string;
  email: string | null;
  series_id: string;
  series_title: string;
  episode_no: number;
  country: string | null;
  position_seconds: number;
  duration_seconds: number;
  created_at: string;
}

interface OrderRow {
  order_no: string;
  series_id: string;
  series_title: string;
  email: string | null;
  country: string | null;
  amount_cents: number;
  status: PersistedOrderStatus;
  paypal_order_id: string | null;
  capture_id: string | null;
  note: string | null;
  created_at: string;
  occurred_at: string;
}

const metricCopy: Record<DashboardMetricKey, { title: string; description: string }> = {
  plays: { title: '今日播放量明细', description: '今日触发播放开始的记录，同一会话、短剧和集数只计一次。' },
  orders: { title: '今日订单明细', description: '今日创建的全部订单，包含待支付、处理中、已支付和异常状态。' },
  revenue: { title: '已确认收入明细', description: '今日完成 PayPal 确认且订单状态为已支付的收入记录。' },
  exceptions: { title: '异常订单明细', description: '今日创建且处于支付失败或风控审核状态的订单。' },
};

const asMetric = (value: string | undefined): DashboardMetricKey => {
  if (value === 'plays' || value === 'orders' || value === 'revenue' || value === 'exceptions') return value;
  throw createError({ statusCode: 404, statusMessage: '指标不存在' });
};

const searchValue = (value: unknown) => `%${String(value || '').trim().replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;

export default defineEventHandler(async (event) => {
  const metric = asMetric(getRouterParam(event, 'metric'));
  const query = getQuery(event);
  const page = Math.max(1, Number(query.page) || 1);
  const pageSize = Math.min(100, Math.max(10, Number(query.pageSize) || 20));
  const keyword = String(query.keyword || '').trim();
  const now = new Date();
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const to = new Date(from.getTime() + 86_400_000);
  const fromIso = from.toISOString();
  const toIso = to.toISOString();
  const offset = (page - 1) * pageSize;

  if (metric === 'plays') {
    const conditions = ["pe.event_type = 'start'", 'pe.created_at >= ?', 'pe.created_at < ?'];
    const params: unknown[] = [fromIso, toIso];
    if (keyword) {
      conditions.push("(pe.series_title LIKE ? ESCAPE '\\' OR pe.session_id LIKE ? ESCAPE '\\' OR pe.user_id LIKE ? ESCAPE '\\' OR u.email LIKE ? ESCAPE '\\')");
      const search = searchValue(keyword);
      params.push(search, search, search, search);
    }
    const where = `WHERE ${conditions.join(' AND ')}`;
    const [rows, stats] = await Promise.all([
      d1All<PlaybackRow>(event, `SELECT pe.event_id, pe.session_id, pe.user_id, u.email, pe.series_id,
        pe.series_title, pe.episode_no, pe.country, pe.position_seconds, pe.duration_seconds, pe.created_at
        FROM playback_events pe LEFT JOIN users u ON u.user_id = pe.user_id
        ${where} ORDER BY pe.created_at DESC LIMIT ? OFFSET ?`, [...params, pageSize, offset]),
      d1First<CountRow>(event, `SELECT COUNT(*) AS value FROM playback_events pe
        LEFT JOIN users u ON u.user_id = pe.user_id ${where}`, params),
    ]);
    const items: AdminMetricPlaybackItem[] = rows.map((row) => ({
      eventId: row.event_id,
      sessionId: row.session_id,
      userId: row.user_id,
      email: row.email,
      seriesId: row.series_id,
      seriesTitle: row.series_title,
      episodeNo: Number(row.episode_no),
      country: row.country,
      positionSeconds: Number(row.position_seconds),
      durationSeconds: Number(row.duration_seconds),
      occurredAt: row.created_at,
    }));
    const total = Number(stats?.value || 0);
    const data: AdminMetricDetailResponse = {
      connected: true,
      metric,
      kind: 'playback',
      ...metricCopy[metric],
      value: total,
      recordCount: total,
      generatedAt: now.toISOString(),
      timezone: 'UTC',
      range: { from: fromIso, to: toIso, label: '今日 00:00 - 24:00' },
      page,
      pageSize,
      items,
    };
    return ok(data);
  }

  const conditions: string[] = [];
  const params: unknown[] = [];
  let occurredAt = 'o.created_at';
  if (metric === 'revenue') {
    occurredAt = 'o.callback_at';
    conditions.push("o.status = 'paid'", 'o.callback_at >= ?', 'o.callback_at < ?');
  } else {
    conditions.push('o.created_at >= ?', 'o.created_at < ?');
    if (metric === 'exceptions') conditions.push("o.status IN ('failed', 'risk_review')");
  }
  params.push(fromIso, toIso);
  if (keyword) {
    conditions.push("(o.order_no LIKE ? ESCAPE '\\' OR o.series_title LIKE ? ESCAPE '\\' OR o.email LIKE ? ESCAPE '\\' OR o.paypal_order_id LIKE ? ESCAPE '\\')");
    const search = searchValue(keyword);
    params.push(search, search, search, search);
  }
  const where = `WHERE ${conditions.join(' AND ')}`;
  const [rows, stats] = await Promise.all([
    d1All<OrderRow>(event, `SELECT o.order_no, o.series_id, o.series_title, o.email, o.country,
      o.amount_cents, o.status, o.paypal_order_id, o.capture_id, o.note, o.created_at,
      ${occurredAt} AS occurred_at FROM orders o ${where}
      ORDER BY ${occurredAt} DESC LIMIT ? OFFSET ?`, [...params, pageSize, offset]),
    d1First<CountRow>(event, `SELECT COUNT(*) AS value, COALESCE(SUM(o.amount_cents), 0) AS amount_cents
      FROM orders o ${where}`, params),
  ]);
  const items: AdminMetricOrderItem[] = rows.map((row) => ({
    orderNo: row.order_no,
    seriesId: row.series_id,
    seriesTitle: row.series_title,
    email: row.email,
    country: row.country,
    amount: Number(row.amount_cents) / 100,
    currency: 'USD',
    status: row.status,
    paypalOrderId: row.paypal_order_id,
    captureId: row.capture_id,
    note: row.note,
    createdAt: row.created_at,
    occurredAt: row.occurred_at,
  }));
  const recordCount = Number(stats?.value || 0);
  const value = metric === 'revenue' ? Number(stats?.amount_cents || 0) / 100 : recordCount;
  const data: AdminMetricDetailResponse = {
    connected: true,
    metric,
    kind: 'order',
    ...metricCopy[metric],
    value,
    recordCount,
    generatedAt: now.toISOString(),
    timezone: 'UTC',
    range: { from: fromIso, to: toIso, label: '今日 00:00 - 24:00' },
    page,
    pageSize,
    items,
  };
  return ok(data);
});
