import type { ApiEnvelope } from '~/types/content';
import type { H3Event } from 'h3';

export const ok = <T>(data: T): ApiEnvelope<T> => ({
  code: 0,
  message: 'ok',
  requestId: crypto.randomUUID(),
  data,
});

/** Short browser-only cache for content responses that include user state. */
export const setPrivateContentCacheHeaders = (event: H3Event) => {
  setHeader(event, 'cache-control', 'private, max-age=30, stale-while-revalidate=60');
  setHeader(event, 'vary', 'Cookie');
};
