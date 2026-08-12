import type { ApiEnvelope, HomeResponse, LibraryResponse, Order, PlaybackEventInput, Series, WatchHistoryItem } from '~/types/content';

export const useContentApi = () => {
  const config = useRuntimeConfig();
  const baseURL = config.public.apiBase;

  const request = <T>(path: string, options: Parameters<typeof $fetch>[1] = {}) =>
    $fetch<ApiEnvelope<T>>(path, { baseURL, credentials: 'include', ...options }).then((response) => response.data);

  return {
    getHome: () => request<HomeResponse>('/home'),
    getExplore: (params?: Record<string, string>) => request<Series[]>('/explore', { query: params }),
    getSeries: (slug: string) => request<Series>(`/series/${slug}`),
    getLibrary: () => request<LibraryResponse>('/me/library'),
    getPlayback: (seriesId: string, episodeNo: number, sessionId: string) =>
      request<{ authorized: boolean; signedUrl?: string; expiresAt?: string; trackingToken: string; resumePositionSeconds?: number; resumeDurationSeconds?: number }>('/playback', {
        query: { seriesId, episodeNo, sessionId },
      }),
    recordPlayback: (event: PlaybackEventInput, keepalive = false) => request<{ accepted: true; positionSeconds: number; durationSeconds: number; lastWatchedAt: string }>('/me/watch-history', { method: 'POST', body: event, keepalive }),
    createOrder: (seriesId: string, idempotencyKey?: string) => request<Order>('/orders', { method: 'POST', body: { seriesId, idempotencyKey } }),
    getPayPalConfig: () => request<{ environment: 'sandbox' | 'production'; clientId: string; available: boolean }>('/paypal/config'),
    capturePayPalOrder: (paypalOrderId: string) => request<{ orderNo: string; status: 'paid' }>('/paypal/capture', { method: 'POST', body: { paypalOrderId } }),
    getMyOrders: () => request<Order[]>('/me/orders'),
    getOrder: (orderNo: string) => request<Order>(`/orders/${orderNo}`),
    restoreOrder: (lookup: string) => request<{ restored: number }>('/orders/restore', {
      method: 'POST',
      body: { lookup },
    }),
    getWatchHistory: () => request<WatchHistoryItem[]>('/me/watch-history'),
    clearWatchHistory: () => request<{ cleared: true }>('/me/watch-history', { method: 'DELETE' }),
  };
};
