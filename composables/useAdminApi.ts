import type { ApiEnvelope } from '~/types/content';
import type { AdminAccount, AdminAuditResponse, AdminOrdersResponse, AdminPendingItemsResponse, AdminSeries, AdminUsersResponse, DashboardSummary, DomainConfig, PersistedUserStatus, PublishStatus, ReconciliationResponse, TaxonomyItem } from '~/types/admin';
import type { HomeSectionConfig } from '~/composables/useAdminStore';

export const useAdminApi = () => {
  const config = useRuntimeConfig();
  const request = <T>(path: string, options: Parameters<typeof $fetch>[1] = {}) =>
    $fetch<ApiEnvelope<T>>(path, { baseURL: config.public.apiBase, credentials: 'include', timeout: 20_000, ...options }).then((response) => response.data);

  return {
    getDashboard: () => request<DashboardSummary>('/admin/dashboard'),
    getPendingItems: () => request<AdminPendingItemsResponse>('/admin/pending-items'),
    getOrders: (query: Record<string, string | number | undefined> = {}) => request<AdminOrdersResponse>('/admin/orders', { query }),
    getUsers: (query: Record<string, string | number | undefined> = {}) => request<AdminUsersResponse>('/admin/users', { query }),
    getAudit: (query: Record<string, string | number | undefined> = {}) => request<AdminAuditResponse>('/admin/audit', { query }),
    updateUserStatus: (userId: string, status: PersistedUserStatus) => request<{ userId: string; status: PersistedUserStatus }>(`/admin/users/${encodeURIComponent(userId)}`, { method: 'PATCH', body: { status } }),
    releaseUserDevice: (userId: string) => request<{ userId: string; status: PersistedUserStatus }>(`/admin/users/${encodeURIComponent(userId)}/release-device`, { method: 'POST' }),
    grantUserEntitlement: (userId: string, seriesId: string, reason: string) => request<{ userId: string; seriesId: string; status: 'granted' }>(`/admin/users/${encodeURIComponent(userId)}/entitlements`, { method: 'POST', body: { seriesId, reason } }),
    verifyOrder: (orderNo: string) => request<{ paypalStatus: string; captureStatus: string | null; synchronized: boolean }>(`/admin/orders/${orderNo}/verify`, { method: 'POST' }),
    refundOrder: (orderNo: string, reason: string) => request<{ orderNo: string; paypalRefundId?: string; status: 'refunding' | 'refunded'; synchronized: boolean }>(`/admin/orders/${orderNo}/refund`, { method: 'POST', body: { reason } }),
    getReconciliation: (days: number) => request<ReconciliationResponse>('/admin/reconciliation', { query: { days } }),
    getConnection: () => request<{
      checkedAt: string;
      cloudflare: { database: boolean; databaseError: string | null; mode: string; accountConfigured: boolean; databaseConfigured: boolean; apiTokenConfigured: boolean; mediaConfigured: boolean };
      paypal: { connected: boolean; error: string | null; environment: string; webhookConfigured: boolean; lastWebhookAt: string | null };
    }>('/admin/connection'),
    getHomeConfig: () => request<{ items: HomeSectionConfig[] }>('/admin/home-config'),
    saveHomeConfig: (items: HomeSectionConfig[]) => request<{ items: HomeSectionConfig[] }>('/admin/home-config', { method: 'PUT', body: { items } }),
    getSeries: () => request<{ items: AdminSeries[]; generatedAt: string }>('/admin/series'),
    createSeries: (input: Pick<AdminSeries, 'title' | 'description' | 'genres' | 'targetRegion' | 'freeEpisodeCount' | 'price'>) => request<AdminSeries>('/admin/series', { method: 'POST', body: input }),
    updateSeries: (id: string, input: Pick<AdminSeries, 'title' | 'description' | 'genres' | 'targetRegion' | 'freeEpisodeCount' | 'price'>) => request<AdminSeries>(`/admin/series/${encodeURIComponent(id)}`, { method: 'PUT', body: input }),
    updateSeriesStatus: (id: string, publishStatus: PublishStatus) => request<AdminSeries>(`/admin/series/${encodeURIComponent(id)}/status`, { method: 'PATCH', body: { publishStatus } }),
    duplicateSeries: (id: string) => request<AdminSeries>(`/admin/series/${encodeURIComponent(id)}/duplicate`, { method: 'POST' }),
    getTaxonomy: () => request<{ items: TaxonomyItem[] }>('/admin/taxonomy'),
    saveTaxonomy: (items: TaxonomyItem[]) => request<{ items: TaxonomyItem[] }>('/admin/taxonomy', { method: 'PUT', body: { items } }),
    getDomains: () => request<{ items: DomainConfig[]; cnameTarget: string }>('/admin/domains'),
    addDomain: (host: string) => request<DomainConfig>('/admin/domains', { method: 'POST', body: { host } }),
    updateDomain: (id: string, input: { action: 'set-primary' } | { action: 'set-redirect'; redirect: boolean }) => request<DomainConfig>(`/admin/domains/${encodeURIComponent(id)}`, { method: 'PATCH', body: input }),
    verifyDomain: (id: string) => request<DomainConfig>(`/admin/domains/${encodeURIComponent(id)}/verify`, { method: 'POST' }),
    getAdministrators: () => request<{ items: AdminAccount[] }>('/admin/administrators'),
    createAdministrator: (input: { name: string; email: string }) => request<{ account: AdminAccount; initialPassword: string }>('/admin/administrators', { method: 'POST', body: input }),
    updateAdministratorStatus: (id: string, status: 'active' | 'disabled') => request<AdminAccount>(`/admin/administrators/${encodeURIComponent(id)}`, { method: 'PATCH', body: { status } }),
    deleteAdministrator: (id: string) => request<{ id: string }>(`/admin/administrators/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  };
};
