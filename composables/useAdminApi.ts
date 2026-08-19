import type { ApiEnvelope } from '~/types/content';
import type { AdminAccount, AdminAuditResponse, AdminEpisode, AdminOrdersResponse, AdminPendingItemsResponse, AdminRole, AdminSeries, AdminUserDetail, AdminUsersResponse, DashboardSummary, DomainConfig, MediaUploadPart, MediaUploadSession, PersistedUserStatus, PublishStatus, ReconciliationResponse, TaxonomyItem } from '~/types/admin';
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
    getUserDetail: (userId: string) => request<AdminUserDetail>(`/admin/users/${encodeURIComponent(userId)}`),
    getAudit: (query: Record<string, string | number | undefined> = {}) => request<AdminAuditResponse>('/admin/audit', { query }),
    updateUserStatus: (userId: string, status: PersistedUserStatus) => request<{ userId: string; status: PersistedUserStatus }>(`/admin/users/${encodeURIComponent(userId)}`, { method: 'PATCH', body: { status } }),
    releaseUserDevice: (userId: string) => request<{ userId: string; status: PersistedUserStatus }>(`/admin/users/${encodeURIComponent(userId)}/release-device`, { method: 'POST' }),
    grantUserEntitlement: (userId: string, seriesId: string, reason: string) => request<{ userId: string; seriesId: string; status: 'granted' }>(`/admin/users/${encodeURIComponent(userId)}/entitlements`, { method: 'POST', body: { seriesId, reason } }),
    verifyOrder: (orderNo: string) => request<{ paypalStatus: string; captureStatus: string | null; refundStatus: string | null; synchronized: boolean }>(`/admin/orders/${orderNo}/verify`, { method: 'POST' }),
    refundOrder: (orderNo: string, reason: string, input: { method?: 'paypal_api' | 'manual' | 'reject'; providerStatus?: string; paypalRefundId?: string } = {}) => request<{ orderNo: string; paypalRefundId?: string; status: 'pending' | 'processing' | 'refunding' | 'refunded' | 'paid' | 'failed' | 'rejected'; synchronized: boolean }>(`/admin/orders/${orderNo}/refund`, { method: 'POST', body: { reason, ...input } }),
    getRefund: (orderNo: string) => request<{ orderNo: string; requests: Array<Record<string, unknown>>; events: Array<Record<string, unknown>> }>(`/admin/orders/${orderNo}/refund`),
    retryPayPalWebhook: (eventId: string) => request<{ eventId: string; status: 'processed' | 'ignored'; retryCount: number }>(`/admin/paypal/webhooks/${encodeURIComponent(eventId)}/retry`, { method: 'POST' }),
    getReconciliation: (days: number) => request<ReconciliationResponse>('/admin/reconciliation', { query: { days } }),
    getConnection: () => request<{
      checkedAt: string;
      cloudflare: {
        database: boolean; databaseError: string | null; mode: string; accountConfigured: boolean; databaseConfigured: boolean; apiTokenConfigured: boolean;
        databaseSchema: { healthy: boolean; latestRequiredMigration: number; latestAppliedMigration: number; migrationHistoryValid: boolean; migrationError: string | null; missing: { tables: string[]; columns: string[]; indexes: string[]; triggers: string[] } } | null;
        streamApiConfigured: boolean; streamApiError: string | null; streamCustomerCodeConfigured: boolean; streamWebhookConfigured: boolean;
        uploadConfigured: boolean; mediaConfigured: boolean; mediaWorkerConfigured: boolean; streamConfigured: boolean; mediaSigningConfigured: boolean; customHostnamesConfigured: boolean;
        customHostnamesMissingFields: Array<'zoneId' | 'apiToken' | 'cnameTarget'>;
        missingFields: { streamApi: string[]; mediaWorker: string[]; playback: string[]; streamWebhook: string[] };
      };
      paypal: { connected: boolean; ready: boolean; error: string | null; environment: 'sandbox' | 'production'; environmentValid: boolean; credentialsConfigured: boolean; browserClientConfigured: boolean; clientIdsMatch: boolean; webhookConfigured: boolean; environments: Record<'sandbox' | 'production', { credentialsConfigured: boolean; browserClientConfigured: boolean; clientIdsMatch: boolean; webhookConfigured: boolean }>; lastWebhookAt: string | null; failedWebhooks: Array<{ eventId: string; eventType: string; errorMessage: string | null; receivedAt: string; retryCount: number; replayable: boolean }> };
    }>('/admin/connection'),
    switchPayPalEnvironment: (environment: 'sandbox' | 'production') => request<{ environment: 'sandbox' | 'production'; changed: boolean }>('/admin/paypal/environment', { method: 'PATCH', body: { environment } }),
    getHomeConfig: () => request<{ items: HomeSectionConfig[] }>('/admin/home-config'),
    saveHomeConfig: (items: HomeSectionConfig[]) => request<{ items: HomeSectionConfig[] }>('/admin/home-config', { method: 'PUT', body: { items } }),
    getSeries: () => request<{ items: AdminSeries[]; generatedAt: string }>('/admin/series'),
    createSeries: (input: Pick<AdminSeries, 'title' | 'description' | 'genres' | 'targetRegion' | 'freeEpisodeCount' | 'price'>) => request<AdminSeries>('/admin/series', { method: 'POST', body: input }),
    updateSeries: (id: string, input: Pick<AdminSeries, 'title' | 'description' | 'genres' | 'targetRegion' | 'freeEpisodeCount' | 'price'>) => request<AdminSeries>(`/admin/series/${encodeURIComponent(id)}`, { method: 'PUT', body: input }),
    updateSeriesStatus: (id: string, publishStatus: PublishStatus) => request<AdminSeries>(`/admin/series/${encodeURIComponent(id)}/status`, { method: 'PATCH', body: { publishStatus } }),
    duplicateSeries: (id: string) => request<AdminSeries>(`/admin/series/${encodeURIComponent(id)}/duplicate`, { method: 'POST' }),
    deleteSeries: (id: string) => request<{ id: string; title: string; retainedOrderCount: number }>(`/admin/series/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    getEpisodes: (seriesId: string) => request<{ items: AdminEpisode[]; generatedAt: string }>(`/admin/series/${encodeURIComponent(seriesId)}/episodes`),
    createEpisodeUpload: (seriesId: string, input: { idempotencyKey: string; episodeNo: number; title: string; fileName: string; contentType: string; fileSizeBytes: number; durationSeconds: number; width: number; height: number; hasVideo: true; hasAudio: true }) =>
      request<MediaUploadSession>(`/admin/series/${encodeURIComponent(seriesId)}/episodes/uploads`, { method: 'POST', body: input }),
    reportUploadProgress: (uploadId: string, uploadedBytes: number) => request<{ uploadedBytes: number; fileSizeBytes: number }>(`/admin/media/uploads/${encodeURIComponent(uploadId)}/progress`, { method: 'PATCH', body: { uploadedBytes } }),
    getEpisodeUpload: (uploadId: string) => request<{ uploadId: string; mediaAssetId: string; status: string; uploadedBytes: number; fileSizeBytes: number; r2Completed: boolean; streamUid: string | null; recoverable: boolean; errorMessage: string | null; updatedAt: string | null }>(`/admin/media/uploads/${encodeURIComponent(uploadId)}`),
    completeEpisodeUpload: (uploadId: string, parts: MediaUploadPart[]) => request<{ uploadId: string; mediaAssetId: string; streamUid: string | null; status: 'processing' | 'completing'; errorMessage?: string }>(`/admin/media/uploads/${encodeURIComponent(uploadId)}/complete`, { method: 'POST', body: { parts } }),
    retryTranscode: (assetId: string) => request<{ assetId: string; streamUid: string; attempt: number; status: 'processing' }>(`/admin/media/${encodeURIComponent(assetId)}/retry`, { method: 'POST' }),
    getTaxonomy: () => request<{ items: TaxonomyItem[] }>('/admin/taxonomy'),
    saveTaxonomy: (items: TaxonomyItem[]) => request<{ items: TaxonomyItem[] }>('/admin/taxonomy', { method: 'PUT', body: { items } }),
    getDomains: () => request<{
      items: DomainConfig[];
      settings: { zoneId: string; cnameTarget: string; apiTokenConfigured: boolean };
      missingFields: Array<'zoneId' | 'apiToken' | 'cnameTarget'>;
      automationConfigured: boolean;
    }>('/admin/domains'),
    saveDomainSettings: (input: { zoneId: string; cnameTarget: string }) => request<{
      settings: { zoneId: string; cnameTarget: string; apiTokenConfigured: boolean };
      missingFields: Array<'zoneId' | 'apiToken' | 'cnameTarget'>;
      automationConfigured: boolean;
    }>('/admin/domains/settings', { method: 'PUT', body: input }),
    addDomain: (host: string) => request<DomainConfig>('/admin/domains', { method: 'POST', body: { host } }),
    updateDomain: (id: string, input: { action: 'set-primary' } | { action: 'set-redirect'; redirect: boolean }) => request<DomainConfig>(`/admin/domains/${encodeURIComponent(id)}`, { method: 'PATCH', body: input }),
    verifyDomain: (id: string) => request<DomainConfig>(`/admin/domains/${encodeURIComponent(id)}/verify`, { method: 'POST' }),
    deleteDomain: (id: string) => request<{ id: string; host: string }>(`/admin/domains/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    getAdministrators: () => request<{ items: AdminAccount[] }>('/admin/administrators'),
    createAdministrator: (input: { name: string; email: string; role: Exclude<AdminRole, 'super_admin'> }) => request<{ account: AdminAccount; initialPassword: string }>('/admin/administrators', { method: 'POST', body: input }),
    updateAdministratorStatus: (id: string, status: 'active' | 'disabled') => request<AdminAccount>(`/admin/administrators/${encodeURIComponent(id)}`, { method: 'PATCH', body: { status } }),
    updateAdministratorRole: (id: string, role: Exclude<AdminRole, 'super_admin'>) => request<AdminAccount>(`/admin/administrators/${encodeURIComponent(id)}`, { method: 'PATCH', body: { role } }),
    deleteAdministrator: (id: string) => request<{ id: string }>(`/admin/administrators/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  };
};
