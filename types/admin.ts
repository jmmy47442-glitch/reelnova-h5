export interface DashboardMetric {
  value: number;
  previousValue: number;
  changePercent: number | null;
}

export type AdminRole = 'super_admin' | 'admin';
export type AdminAccountStatus = 'invited' | 'active' | 'disabled';

export interface AdminSession {
  id: string;
  email: string;
  name: string;
  role: AdminRole;
  loggedInAt: string;
  expiresAt: string;
}

export interface AdminAccount {
  id: string;
  email: string;
  name: string;
  role: AdminRole;
  status: AdminAccountStatus;
  invitedBy: string | null;
  invitedAt: string | null;
  lastLoginAt: string | null;
  createdAt: string;
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
export type PersistedRefundStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'rejected' | 'cancelled';

export type PublishStatus = '已上架' | '处理中' | '草稿' | '待发布' | '已下架' | '版权冻结';

export interface AdminSeries {
  id: string;
  slug: string;
  title: string;
  description: string;
  coverUrl: string;
  genres: string[];
  episodeCount: number;
  freeEpisodeCount: number;
  price: number;
  originalPrice?: number;
  publishStatus: PublishStatus;
  publishAt: string;
  transcodeProgress: number;
  targetRegion: string;
}

export type EpisodeVideoStatus = 'waiting_upload' | 'uploading' | 'validating' | 'processing' | 'ready' | 'failed';

export interface AdminEpisode {
  id: string;
  episodeNo: number;
  title: string;
  durationSeconds: number;
  isFree: boolean;
  videoStatus: EpisodeVideoStatus;
  transcodeProgress: number;
  thumbnailUrl: string;
  mediaAssetId: string | null;
  sourceFileName: string | null;
  sourceSizeBytes: number | null;
  errorMessage: string | null;
  previewUrl: string | null;
}

export interface MediaUploadSession {
  id: string;
  episodeId: string;
  mediaAssetId: string;
  episodeNo: number;
  uploadUrl: string;
  uploadToken: string;
  partSizeBytes: number;
  expiresAt: string;
}

export interface MediaUploadPart {
  partNumber: number;
  etag: string;
}

export interface TaxonomyItem {
  id: string;
  name: string;
  localeName: string;
  type: '分类' | '标签';
  color: string;
  contentCount: number;
  enabled: boolean;
  expiresAt: string;
}

export interface DomainConfig {
  id: string;
  host: string;
  role: '主域名' | '备用域名';
  verification: '已验证' | '待验证' | '验证失败';
  certificate: '正常' | '即将到期' | '未签发';
  redirect: boolean;
  updatedAt: string;
}

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
  refund: {
    status: PersistedRefundStatus | null;
    paypalRefundId: string | null;
    source: 'paypal_api' | 'manual' | 'webhook' | null;
    entitlementRevokeStatus: 'pending' | 'revoked' | 'not_applicable' | 'failed' | null;
    errorMessage: string | null;
    updatedAt: string | null;
  };
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

export type AdminPendingItemSeverity = 'warning' | 'danger';

export interface AdminPendingItem {
  id: string;
  title: string;
  description: string;
  count: number;
  severity: AdminPendingItemSeverity;
  to: string;
  latestAt: string | null;
}

export interface AdminPendingItemsResponse {
  connected: true;
  generatedAt: string;
  total: number;
  items: AdminPendingItem[];
}

export type PersistedUserStatus = 'active' | 'restricted' | 'disabled';

export interface PersistedUser {
  id: string;
  name: string;
  email: string;
  country: string;
  device: string;
  status: PersistedUserStatus;
  entitlements: number;
  orders: number;
  lastSeenAt: string;
  createdAt: string;
}

export interface AdminUsersResponse {
  connected: true;
  generatedAt: string;
  items: PersistedUser[];
  total: number;
  countries: string[];
}

export type AuditRisk = '普通' | '高风险';

export interface AuditLog {
  id: string;
  actor: string;
  module: string;
  action: string;
  target: string;
  detail: string;
  risk: AuditRisk;
  ip: string | null;
  createdAt: string;
}

export interface AdminAuditResponse {
  connected: true;
  generatedAt: string;
  items: AuditLog[];
  total: number;
  modules: string[];
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
