import type { ApiEnvelope } from '~/types/content';
import type { AdminOrdersResponse, DashboardSummary, ReconciliationResponse } from '~/types/admin';

export const useAdminApi = () => {
  const request = <T>(path: string, options: Parameters<typeof $fetch>[1] = {}) =>
    $fetch<ApiEnvelope<T>>(path, options).then((response) => response.data);

  return {
    getDashboard: () => request<DashboardSummary>('/api/admin/dashboard'),
    getOrders: (query: Record<string, string | number | undefined> = {}) => request<AdminOrdersResponse>('/api/admin/orders', { query }),
    verifyOrder: (orderNo: string) => request<{ paypalStatus: string; captureStatus: string | null; synchronized: boolean }>(`/api/admin/orders/${orderNo}/verify`, { method: 'POST' }),
    getReconciliation: (days: number) => request<ReconciliationResponse>('/api/admin/reconciliation', { query: { days } }),
    getConnection: () => request<{
      checkedAt: string;
      cloudflare: { database: boolean; databaseError: string | null; mode: string; accountConfigured: boolean; databaseConfigured: boolean; apiTokenConfigured: boolean; mediaConfigured: boolean };
      paypal: { connected: boolean; error: string | null; environment: string; webhookConfigured: boolean; lastWebhookAt: string | null };
    }>('/api/admin/connection'),
  };
};
