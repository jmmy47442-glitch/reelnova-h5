export interface DashboardMetric {
  value: number;
  previousValue: number;
  changePercent: number | null;
}

export interface DashboardTrendPoint {
  date: string;
  plays: number;
  revenue: number;
}

export interface DashboardSeriesRow {
  seriesId: string;
  title: string;
  plays: number;
  paidOrders: number;
  revenue: number;
  conversion: number;
}

export interface DashboardSummary {
  connected: true;
  source: 'Cloudflare D1';
  generatedAt: string;
  timezone: string;
  metrics: {
    plays: DashboardMetric;
    orders: DashboardMetric;
    revenue: DashboardMetric;
    exceptions: DashboardMetric;
  };
  trends: DashboardTrendPoint[];
  topSeries: DashboardSeriesRow[];
  health: {
    database: 'ok';
    lastWebhookAt: string | null;
    pendingOrders: number;
    failedWebhooks: number;
  };
}

export type PersistedOrderStatus = 'pending' | 'processing' | 'paid' | 'failed' | 'cancelled' | 'refunding' | 'refunded' | 'risk_review';

export interface PersistedOrder {
  orderNo: string;
  seriesId: string;
  seriesTitle: string;
  email: string | null;
  country: string | null;
  amount: number;
  currency: 'USD';
  fee: number;
  netAmount: number;
  status: PersistedOrderStatus;
  paypalOrderId: string | null;
  captureId: string | null;
  createdAt: string;
  callbackAt: string | null;
  entitlement: 'pending' | 'granted' | 'revoked';
  note: string | null;
}

export interface AdminOrdersResponse {
  connected: true;
  generatedAt: string;
  items: PersistedOrder[];
  total: number;
  summary: {
    todayOrders: number;
    paidAmount: number;
    pending: number;
    exceptions: number;
  };
}

export interface ReconciliationRow {
  date: string;
  currency: string;
  gross: number;
  fee: number;
  refunds: number;
  net: number;
  paid: number;
  exceptions: number;
}

export interface ReconciliationResponse {
  connected: true;
  generatedAt: string;
  rows: ReconciliationRow[];
}

export interface PlaybackEventInput {
  eventId: string;
  sessionId: string;
  seriesId: string;
  seriesTitle: string;
  episodeNo: number;
  eventType: 'start' | 'heartbeat' | 'complete';
  positionSeconds: number;
  durationSeconds: number;
  authorizationToken: string;
}
