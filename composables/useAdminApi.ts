import type { ApiEnvelope } from '~/types/content';
import type { AdminAccount, AdminAuditResponse, AdminOrdersResponse, AdminPendingItemsResponse, AdminUsersResponse, DashboardSummary, PersistedUserStatus, ReconciliationResponse } from '~/types/admin';
import type { HomeSectionConfig } from '~/composables/useAdminStore';

export const useAdminApi = () => {
  const request = <T>(path: string, options: Parameters<typeof $fetch>[1] = {}) =>
    $fetch<ApiEnvelope<T>>(path, { timeout: 20_000, ...options }).then((response) => response.data);

  return {
    getDashboard: () => request<DashboardSummary>('/api/admin/dashboard'),
    getPendingItems: () => request<AdminPendingItemsResponse>('/api/admin/pending-items'),
    getOrders: (query: Record<string, string | number | undefined> = {}) => request<AdminOrdersResponse>('/api/admin/orders', { query }),
    getUsers: (query: Record<string, string | number | undefined> = {}) => request<AdminUsersResponse>('/api/admin/users', { query }),
    getAudit: (query: Record<string, string | number | undefined> = {}) => request<AdminAuditResponse>('/api/admin/audit', { query }),
    updateUserStatus: (visitorId: string, status: PersistedUserStatus) => request<{ visitorId: string; status: PersistedUserStatus }>(`/api/admin/users/${encodeURIComponent(visitorId)}`, { method: 'PATCH', body: { status } }),
    releaseUserDevice: (visitorId: string) => request<{ visitorId: string; status: PersistedUserStatus }>(`/api/admin/users/${encodeURIComponent(visitorId)}/release-device`, { method: 'POST' }),
    grantUserEntitlement: (visitorId: string, seriesId: string, reason: string) => request<{ visitorId: string; seriesId: string; status: 'granted' }>(`/api/admin/users/${encodeURIComponent(visitorId)}/entitlements`, { method: 'POST', body: { seriesId, reason } }),
    verifyOrder: (orderNo: string) => request<{ paypalStatus: string; captureStatus: string | null; synchronized: boolean }>(`/api/admin/orders/${orderNo}/verify`, { method: 'POST' }),
    getReconciliation: (days: number) => request<ReconciliationResponse>('/api/admin/reconciliation', { query: { days } }),
    getConnection: () => request<{
      checkedAt: string;
      cloudflare: { database: boolean; databaseError: string | null; mode: string; accountConfigured: boolean; databaseConfigured: boolean; apiTokenConfigured: boolean; mediaConfigured: boolean };
      paypal: { connected: boolean; error: string | null; environment: string; webhookConfigured: boolean; lastWebhookAt: string | null };
    }>('/api/admin/connection'),
    getHomeConfig: () => request<{ items: HomeSectionConfig[] }>('/api/admin/home-config'),
    saveHomeConfig: (items: HomeSectionConfig[]) => request<{ items: HomeSectionConfig[] }>('/api/admin/home-config', { method: 'PUT', body: { items } }),
    getAdministrators: () => request<{ items: AdminAccount[] }>('/api/admin/administrators'),
    createAdministrator: (input: { name: string; email: string }) => request<{ account: AdminAccount; initialPassword: string }>('/api/admin/administrators', { method: 'POST', body: input }),
    updateAdministratorStatus: (id: string, status: 'active' | 'disabled') => request<AdminAccount>(`/api/admin/administrators/${encodeURIComponent(id)}`, { method: 'PATCH', body: { status } }),
    deleteAdministrator: (id: string) => request<{ id: string }>(`/api/admin/administrators/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  };
};
