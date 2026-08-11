import type { ApiEnvelope, HomeResponse, LibraryResponse, Order, Series } from '~/types/content';
import type { PlaybackEventInput } from '~/types/admin';

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
      request<{ authorized: boolean; signedUrl?: string; expiresAt?: string; trackingToken: string }>('/playback', {
        query: { seriesId, episodeNo, sessionId },
      }),
    recordPlayback: (event: PlaybackEventInput) => request<{ accepted: true }>('/events/playback', { method: 'POST', body: event }),
    createOrder: (seriesId: string) => request<Order>('/orders', { method: 'POST', body: { seriesId } }),
    getMyOrders: () => request<Order[]>('/me/orders'),
    getOrder: (orderNo: string) => request<Order>(`/orders/${orderNo}`),
    restoreOrder: (lookup: string) => request<{ restored: number }>('/orders/restore', {
      method: 'POST',
      body: { lookup },
    }),
  };
};
