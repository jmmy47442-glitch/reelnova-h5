import type { ApiEnvelope } from '~/types/content';

export const ok = <T>(data: T): ApiEnvelope<T> => ({
  code: 0,
  message: 'ok',
  requestId: crypto.randomUUID(),
  data,
});
