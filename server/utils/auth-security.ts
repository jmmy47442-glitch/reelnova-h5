import type { H3Event } from 'h3';
import { d1First, d1Run, hasD1Connection } from './cloudflare-d1';

const encoder = new TextEncoder();

const bytesToBase64Url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))
  .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '');

const digest = async (value: string) => bytesToBase64Url(new Uint8Array(
  await crypto.subtle.digest('SHA-256', encoder.encode(value)),
));

export const clientIp = (event: H3Event) =>
  getHeader(event, 'cf-connecting-ip')
  || getHeader(event, 'x-forwarded-for')?.split(',')[0]?.trim()
  || getHeader(event, 'x-real-ip')
  || 'unknown';

const secretForHash = (event: H3Event) => String(useRuntimeConfig(event).userSessionSecret || 'rate-limit');
const canUseMemoryAuth = (event: H3Event) => process.env.NODE_ENV === 'development' && !hasD1Connection(event);

interface MemoryRateLimit {
  windowStartedAt: number;
  requestCount: number;
  blockedUntil: number | null;
}

const memoryRateLimits = new Map<string, MemoryRateLimit>();
const memoryChallenges = new Map<string, { email: string; purpose: 'login' | 'reset'; expiresAt: number }>();

export const enforceAuthRateLimit = async (
  event: H3Event,
  scope: string,
  email: string | undefined,
  limits: { ip: number; email: number; windowSeconds: number; blockSeconds: number },
) => {
  const now = Math.floor(Date.now() / 1000);
  const windowStartedAt = now - (now % limits.windowSeconds);
  const keys = [
    `ip:${await digest(`${secretForHash(event)}:${scope}:${clientIp(event)}`)}`,
    ...(email ? [`email:${await digest(`${secretForHash(event)}:${scope}:${email.toLowerCase()}`)}`] : []),
  ];
  if (canUseMemoryAuth(event)) {
    for (const bucketKey of keys) {
      const current = memoryRateLimits.get(bucketKey);
      const bucket = current?.windowStartedAt === windowStartedAt
        ? current
        : { windowStartedAt, requestCount: 0, blockedUntil: null };
      bucket.requestCount += 1;
      memoryRateLimits.set(bucketKey, bucket);
      if (bucket.blockedUntil && bucket.blockedUntil > now) {
        const retryAfter = bucket.blockedUntil - now;
        setHeader(event, 'retry-after', retryAfter);
        throw createError({ statusCode: 429, statusMessage: 'Too many authentication attempts', data: { retryAfter } });
      }
      if (bucket.requestCount > (bucketKey.startsWith('ip:') ? limits.ip : limits.email)) {
        bucket.blockedUntil = now + limits.blockSeconds;
        memoryRateLimits.set(bucketKey, bucket);
        setHeader(event, 'retry-after', limits.blockSeconds);
        throw createError({ statusCode: 429, statusMessage: 'Too many authentication attempts', data: { retryAfter: limits.blockSeconds } });
      }
    }
    return;
  }
  for (const bucketKey of keys) {
    await d1Run(event, `INSERT INTO auth_rate_limits (bucket_key, window_started_at, request_count, blocked_until, updated_at)
      VALUES (?, ?, 1, NULL, ?)
      ON CONFLICT(bucket_key) DO UPDATE SET
        request_count = CASE WHEN auth_rate_limits.window_started_at = ? THEN auth_rate_limits.request_count + 1 ELSE 1 END,
        window_started_at = CASE WHEN auth_rate_limits.window_started_at = ? THEN auth_rate_limits.window_started_at ELSE ? END,
        blocked_until = CASE WHEN auth_rate_limits.window_started_at = ? THEN auth_rate_limits.blocked_until ELSE NULL END,
        updated_at = excluded.updated_at`,
    [bucketKey, windowStartedAt, new Date().toISOString(), windowStartedAt, windowStartedAt, windowStartedAt, windowStartedAt]);
    const row = await d1First<{ request_count: number; blocked_until: number | null }>(event,
      'SELECT request_count, blocked_until FROM auth_rate_limits WHERE bucket_key = ?', [bucketKey]);
    if (row?.blocked_until && row.blocked_until > now) {
      const retryAfter = row.blocked_until - now;
      setHeader(event, 'retry-after', retryAfter);
      throw createError({ statusCode: 429, statusMessage: 'Too many authentication attempts', data: { retryAfter } });
    }
    if (Number(row?.request_count || 0) > (bucketKey.startsWith('ip:') ? limits.ip : limits.email)) {
      const blockedUntil = now + limits.blockSeconds;
      await d1Run(event, 'UPDATE auth_rate_limits SET blocked_until = ?, updated_at = ? WHERE bucket_key = ?', [blockedUntil, new Date().toISOString(), bucketKey]);
      setHeader(event, 'retry-after', limits.blockSeconds);
      throw createError({ statusCode: 429, statusMessage: 'Too many authentication attempts', data: { retryAfter: limits.blockSeconds } });
    }
  }
};

export const storeChallenge = async (event: H3Event, input: { nonce: string; email: string; purpose: 'login' | 'reset'; expiresAt: number }) => {
  if (canUseMemoryAuth(event)) {
    const now = Date.now();
    for (const [nonce, challenge] of memoryChallenges) {
      if (challenge.expiresAt <= now) memoryChallenges.delete(nonce);
    }
    memoryChallenges.set(input.nonce, { email: input.email, purpose: input.purpose, expiresAt: input.expiresAt });
    return;
  }
  const now = Math.floor(Date.now() / 1000);
  await d1Run(event, `DELETE FROM auth_challenges WHERE expires_at < ? OR consumed_at IS NOT NULL`, [now - 300]);
  await d1Run(event, `INSERT INTO auth_challenges (nonce, email, purpose, expires_at, consumed_at, created_at) VALUES (?, ?, ?, ?, NULL, ?)`, [input.nonce, input.email, input.purpose, Math.floor(input.expiresAt / 1000), now]);
};

export const consumeChallenge = async (event: H3Event, nonce: string, email: string, purpose: 'login' | 'reset') => {
  if (canUseMemoryAuth(event)) {
    const challenge = memoryChallenges.get(nonce);
    if (!challenge || challenge.email.toLowerCase() !== email.toLowerCase() || challenge.purpose !== purpose || challenge.expiresAt <= Date.now()) return false;
    memoryChallenges.delete(nonce);
    return true;
  }
  const now = Math.floor(Date.now() / 1000);
  const result = await d1Run(event, `UPDATE auth_challenges SET consumed_at = ? WHERE nonce = ? AND email = ? COLLATE NOCASE AND purpose = ? AND consumed_at IS NULL AND expires_at > ?`, [now, nonce, email, purpose, now]);
  return Number(result?.meta?.changes || 0) === 1;
};
