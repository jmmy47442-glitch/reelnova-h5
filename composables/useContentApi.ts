import type { AnalyticsEventInput, ApiEnvelope, ExploreResponse, HomeResponse, LibraryResponse, Order, PlaybackEventInput, Series, WatchHistoryItem } from '~/types/content';

export type PlaybackAuthorization = {
  authorized: boolean;
  signedUrl?: string;
  originalUrl?: string;
  delivery?: 'mp4' | 'hls';
  prefetchUrls?: string[];
  rendition?: 'original' | 'mobile';
  expiresAt?: string;
  trackingToken: string;
  resumePositionSeconds?: number;
  resumeDurationSeconds?: number;
};

export const useContentApi = () => {
  const config = useRuntimeConfig();
  const baseURL = config.public.apiBase;
  const requestFetch = useRequestFetch();

  const request = <T>(path: string, options: Parameters<typeof $fetch>[1] = {}) =>
    requestFetch<ApiEnvelope<T>>(path, { baseURL, credentials: 'include', ...options }).then((response) => response.data);

  return {
    getHome: () => request<HomeResponse>('/home', { cache: 'no-store' }),
    getExplore: (params?: Record<string, string>) => request<ExploreResponse>('/explore', { query: params, cache: 'no-store' }),
    getSeries: (slug: string) => request<Series>(`/series/${slug}`, { cache: 'no-store' }),
    getLibrary: () => request<LibraryResponse>('/me/library'),
    getPlayback: (seriesId: string, episodeNo: number, sessionId: string, options: { profile?: 'original' | 'mobile'; prewarm?: boolean; signal?: AbortSignal } = {}) =>
      request<PlaybackAuthorization>('/playback', {
        query: { seriesId, episodeNo, sessionId, profile: options.profile, prewarm: options.prewarm },
        signal: options.signal, cache: 'no-store',
      }),
    getPlaybackBySlug: (seriesSlug: string, episodeNo: number, sessionId: string, options: { profile?: 'original' | 'mobile' } = {}) =>
      request<PlaybackAuthorization>('/playback', {
        query: { seriesSlug, episodeNo, sessionId, profile: options.profile }, cache: 'no-store',
      }),
    recordPlayback: (event: PlaybackEventInput, keepalive = false) => request<{ accepted: true; positionSeconds: number; durationSeconds: number; lastWatchedAt: string }>('/me/watch-history', { method: 'POST', body: event, keepalive }),
    recordAnalytics: (event: AnalyticsEventInput, keepalive = false) => request<{ accepted: true }>('/events', { method: 'POST', body: event, keepalive }),
    createOrder: (seriesId: string, idempotencyKey?: string, paymentMethod: 'paypal' | 'card' | 'apple_pay' = 'paypal') => request<Order>('/orders', { method: 'POST', timeout: 15_000, body: { seriesId, idempotencyKey, paymentMethod } }),
    getPayPalConfig: () => request<{ environment: 'sandbox' | 'production'; clientId: string; available: boolean }>('/paypal/config', { timeout: 8_000, retry: 0 }),
    capturePayPalOrder: (paypalOrderId: string) => request<{ orderNo: string; status: 'paid' }>('/paypal/capture', { method: 'POST', body: { paypalOrderId } }),
    cancelPayPalOrder: (paypalOrderId: string) => request<{ orderNo: string; status: 'paid' | 'cancelled' }>('/paypal/cancel', { method: 'POST', body: { paypalOrderId } }),
    getMyOrders: () => request<Order[]>('/me/orders'),
    requestRefund: (orderNo: string, reason: string) => request<{ orderNo: string; refundStatus: NonNullable<Order['refundStatus']> }>(`/me/orders/${encodeURIComponent(orderNo)}/refund`, { method: 'POST', body: { reason } }),
    getOrder: (orderNo: string) => request<Order>(`/orders/${orderNo}`),
    restoreOrder: (lookup: string) => request<{ restored: number }>('/orders/restore', {
      method: 'POST',
      body: { lookup },
    }),
    getWatchHistory: () => request<WatchHistoryItem[]>('/me/watch-history'),
    clearWatchHistory: () => request<{ cleared: true }>('/me/watch-history', { method: 'DELETE' }),
  };
};
