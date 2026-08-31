import type { H3Event } from 'h3';
import { d1First, d1Run } from './cloudflare-d1';
import { getPlaybackAuthorizationSecret, signPlaybackAuthorization } from './playback-authorization';

const deviceCookie = 'reelnova-playback-device';
const deviceCookieMaxAge = 60 * 60 * 24 * 365;
const sessionMaxAgeSeconds = 60 * 60 * 2;
const activeSessionIdleSeconds = 30 * 60;
const maxActiveDevices = 2;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface PlaybackClientContext {
  deviceId: string;
  deviceHash: string;
  ip: string;
  ipHash: string;
  userAgent: string;
  userAgentHash: string;
}

interface PlaybackSessionRow {
  session_id: string;
  user_id: string;
  series_id: string;
  episode_no: number;
  device_hash: string;
  ip_hash: string;
  user_agent_hash: string;
  status: 'active' | 'revoked' | 'expired' | 'blocked';
  blocked_reason: string | null;
  token_count: number;
  event_count: number;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
  last_token_at: string | null;
}

const getRequestIp = (event: H3Event) => getHeader(event, 'cf-connecting-ip')
  || getHeader(event, 'x-forwarded-for')?.split(',')[0]?.trim()
  || getHeader(event, 'x-real-ip')
  || 'unknown';

const setDeviceCookie = (event: H3Event, value: string) => {
  const requestUrl = getRequestURL(event);
  const options: NonNullable<Parameters<typeof setCookie>[3]> = {
    httpOnly: true,
    sameSite: 'strict',
    secure: requestUrl.protocol === 'https:',
    maxAge: deviceCookieMaxAge,
    path: '/',
  };
  if (requestUrl.hostname === 'iseedrama.com' || requestUrl.hostname.endsWith('.iseedrama.com')) {
    options.domain = '.iseedrama.com';
  }
  setCookie(event, deviceCookie, value, options);
};

export const getPlaybackClientContext = async (event: H3Event): Promise<PlaybackClientContext> => {
  const secret = getPlaybackAuthorizationSecret(event);
  const deviceId = getCookie(event, deviceCookie) || crypto.randomUUID();
  if (!getCookie(event, deviceCookie)) setDeviceCookie(event, deviceId);
  const ip = getRequestIp(event);
  const userAgent = getHeader(event, 'user-agent') || 'unknown';
  const [deviceHash, ipHash, userAgentHash] = await Promise.all([
    signPlaybackAuthorization(`device:${deviceId}`, secret),
    signPlaybackAuthorization(`ip:${ip}`, secret),
    signPlaybackAuthorization(`ua:${userAgent}`, secret),
  ]);
  return { deviceId, deviceHash, ip, ipHash, userAgent, userAgentHash };
};

const safeDetail = (detail: Record<string, unknown> = {}) => JSON.stringify(Object.fromEntries(
  Object.entries(detail).slice(0, 20).map(([key, value]) => [key.slice(0, 64), typeof value === 'string' ? value.slice(0, 300) : value]),
));

export const recordPlaybackSecurityEvent = async (event: H3Event, input: {
  eventType: string;
  userId?: string | null;
  sessionId?: string | null;
  seriesId?: string | null;
  episodeNo?: number | null;
  deviceHash?: string | null;
  ipHash?: string | null;
  detail?: Record<string, unknown>;
}) => {
  await d1Run(event, `INSERT INTO playback_security_events
    (id, session_id, user_id, series_id, episode_no, event_type, device_hash, ip_hash, detail, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
    `security_${crypto.randomUUID()}`, input.sessionId || null, input.userId || null, input.seriesId || null,
    input.episodeNo ?? null, input.eventType.slice(0, 64), input.deviceHash || null, input.ipHash || null,
    safeDetail(input.detail), new Date().toISOString(),
  ]);
};

const rateLimitKey = async (event: H3Event, value: string) => {
  const secret = getPlaybackAuthorizationSecret(event);
  return `playback:${await signPlaybackAuthorization(value, secret)}`;
};

export const consumePlaybackRateLimit = async (event: H3Event, input: {
  key: string;
  limit: number;
  windowSeconds: number;
  blockSeconds?: number;
}) => {
  const bucketKey = await rateLimitKey(event, input.key);
  const now = Date.now();
  const windowMs = input.windowSeconds * 1000;
  const windowStartedAt = Math.floor(now / windowMs) * windowMs;
  const updatedAt = new Date(now).toISOString();
  await d1Run(event, `INSERT INTO playback_rate_limits
    (bucket_key, window_started_at, request_count, blocked_until, updated_at)
    VALUES (?, ?, 1, NULL, ?)
    ON CONFLICT(bucket_key) DO UPDATE SET
      window_started_at = excluded.window_started_at,
      request_count = CASE WHEN playback_rate_limits.window_started_at = excluded.window_started_at
        THEN playback_rate_limits.request_count + 1 ELSE 1 END,
      blocked_until = CASE WHEN playback_rate_limits.window_started_at = excluded.window_started_at
        THEN playback_rate_limits.blocked_until ELSE NULL END,
      updated_at = excluded.updated_at`, [bucketKey, windowStartedAt, updatedAt]);
  const row = await d1First<{ request_count: number; blocked_until: number | null }>(event,
    'SELECT request_count, blocked_until FROM playback_rate_limits WHERE bucket_key = ?', [bucketKey]);
  const blockedUntil = Number(row?.blocked_until || 0);
  if (blockedUntil > now) return { allowed: false, retryAfterSeconds: Math.ceil((blockedUntil - now) / 1000) };
  if (Number(row?.request_count || 0) > input.limit) {
    const retryAfterSeconds = input.blockSeconds || input.windowSeconds;
    const nextBlockedUntil = now + retryAfterSeconds * 1000;
    await d1Run(event, `UPDATE playback_rate_limits SET blocked_until = ?, updated_at = ?
      WHERE bucket_key = ? AND (blocked_until IS NULL OR blocked_until <= ?)`, [nextBlockedUntil, updatedAt, bucketKey, now]);
    return { allowed: false, retryAfterSeconds };
  }
  return { allowed: true, retryAfterSeconds: 0 };
};

export const enforcePlaybackRateLimits = async (event: H3Event, context: PlaybackClientContext, userId: string, sessionId?: string) => {
  const checks = [
    { key: `ip:${context.ipHash}`, limit: 90, windowSeconds: 60, blockSeconds: 120 },
    { key: `user:${userId}`, limit: 30, windowSeconds: 60, blockSeconds: 120 },
    ...(sessionId ? [{ key: `session:${sessionId}`, limit: 20, windowSeconds: 60, blockSeconds: 180 }] : []),
  ];
  for (const check of checks) {
    const result = await consumePlaybackRateLimit(event, check);
    if (!result.allowed) {
      await recordPlaybackSecurityEvent(event, {
        eventType: 'rate_limit_block', userId, sessionId, deviceHash: context.deviceHash, ipHash: context.ipHash,
        detail: { scope: check.key.split(':')[0], retryAfterSeconds: result.retryAfterSeconds },
      }).catch(() => undefined);
      setHeader(event, 'retry-after', result.retryAfterSeconds);
      throw createError({ statusCode: 429, statusMessage: 'Too many playback requests', data: { code: 'PLAYBACK_RATE_LIMITED' } });
    }
  }
};

const expireStaleSessions = (event: H3Event, now: Date) => {
  const nowIso = now.toISOString();
  const staleBefore = new Date(now.getTime() - activeSessionIdleSeconds * 1000).toISOString();
  return d1Run(event, `UPDATE playback_sessions SET status = 'expired'
    WHERE status = 'active' AND (expires_at <= ? OR last_seen_at <= ?)`, [nowIso, staleBefore]);
};

export const establishPlaybackSession = async (event: H3Event, input: {
  sessionId: string;
  userId: string;
  seriesId: string;
  episodeNo: number;
  context: PlaybackClientContext;
}) => {
  if (!uuidPattern.test(input.sessionId)) throw createError({ statusCode: 400, statusMessage: 'Invalid playback session' });
  const now = new Date();
  const nowIso = now.toISOString();
  await expireStaleSessions(event, now);
  const existing = await d1First<PlaybackSessionRow>(event, 'SELECT * FROM playback_sessions WHERE session_id = ? LIMIT 1', [input.sessionId]);
  if (existing) {
    if (existing.user_id !== input.userId || existing.series_id !== input.seriesId || existing.episode_no !== input.episodeNo) {
      await recordPlaybackSecurityEvent(event, { eventType: 'session_scope_mismatch', userId: input.userId, sessionId: input.sessionId, deviceHash: input.context.deviceHash, ipHash: input.context.ipHash });
      throw createError({ statusCode: 401, statusMessage: 'Playback session is invalid' });
    }
    if (existing.status !== 'active' || Date.parse(existing.expires_at) <= now.getTime()) {
      throw createError({ statusCode: 403, statusMessage: 'Playback session has expired' });
    }
    if (existing.device_hash !== input.context.deviceHash) {
      await d1Run(event, `UPDATE playback_sessions SET status = 'blocked', blocked_reason = 'device mismatch', revoked_at = ? WHERE session_id = ?`, [nowIso, input.sessionId]);
      await recordPlaybackSecurityEvent(event, { eventType: 'device_binding_mismatch', userId: input.userId, sessionId: input.sessionId, seriesId: input.seriesId, episodeNo: input.episodeNo, deviceHash: input.context.deviceHash, ipHash: input.context.ipHash });
      throw createError({ statusCode: 403, statusMessage: 'Playback device changed; refresh the episode' });
    }
    await d1Run(event, `UPDATE playback_sessions SET ip_hash = ?, user_agent_hash = ?, last_seen_at = ?,
      last_token_at = ?, token_count = token_count + 1 WHERE session_id = ? AND status = 'active'`, [
      input.context.ipHash, input.context.userAgentHash, nowIso, nowIso, input.sessionId,
    ]);
    return { ...existing, ip_hash: input.context.ipHash, user_agent_hash: input.context.userAgentHash, last_seen_at: nowIso };
  }

  const expiresAt = new Date(now.getTime() + sessionMaxAgeSeconds * 1000).toISOString();
  const staleBefore = new Date(now.getTime() - activeSessionIdleSeconds * 1000).toISOString();
  const result = await d1Run(event, `INSERT INTO playback_sessions
    (session_id, user_id, series_id, episode_no, device_hash, ip_hash, user_agent_hash, status,
     token_count, event_count, created_at, last_seen_at, expires_at, last_token_at)
    SELECT ?, ?, ?, ?, ?, ?, ?, 'active', 1, 0, ?, ?, ?, ?
    WHERE EXISTS (SELECT 1 FROM users WHERE user_id = ?)
      AND (EXISTS (SELECT 1 FROM playback_sessions WHERE user_id = ? AND device_hash = ? AND status = 'active')
        OR (SELECT COUNT(DISTINCT device_hash) FROM playback_sessions
          WHERE user_id = ? AND status = 'active' AND last_seen_at > ?) < ?)`, [
    input.sessionId, input.userId, input.seriesId, input.episodeNo, input.context.deviceHash, input.context.ipHash,
    input.context.userAgentHash, nowIso, nowIso, expiresAt, nowIso, input.userId, input.userId, input.context.deviceHash,
    input.userId, staleBefore, maxActiveDevices,
  ]);
  if (Number(result?.meta?.changes || 0) !== 1) {
    await recordPlaybackSecurityEvent(event, {
      eventType: 'concurrent_device_limit', userId: input.userId, sessionId: input.sessionId, seriesId: input.seriesId,
      episodeNo: input.episodeNo, deviceHash: input.context.deviceHash, ipHash: input.context.ipHash,
      detail: { maxActiveDevices },
    });
    throw createError({ statusCode: 429, statusMessage: 'Playback is already active on too many devices', data: { code: 'PLAYBACK_DEVICE_LIMIT' } });
  }
  return {
    session_id: input.sessionId, user_id: input.userId, series_id: input.seriesId, episode_no: input.episodeNo,
    device_hash: input.context.deviceHash, ip_hash: input.context.ipHash, user_agent_hash: input.context.userAgentHash,
    status: 'active' as const, blocked_reason: null, token_count: 1, event_count: 0, created_at: nowIso,
    last_seen_at: nowIso, expires_at: expiresAt, last_token_at: nowIso,
  } satisfies PlaybackSessionRow;
};

export const verifyPlaybackEventSession = async (event: H3Event, input: {
  sessionId: string;
  userId: string;
  seriesId: string;
  episodeNo: number;
  context: PlaybackClientContext;
}) => {
  const session = await d1First<PlaybackSessionRow>(event, 'SELECT * FROM playback_sessions WHERE session_id = ? LIMIT 1', [input.sessionId]);
  if (!session || session.user_id !== input.userId || session.series_id !== input.seriesId || session.episode_no !== input.episodeNo
    || session.status !== 'active' || Date.parse(session.expires_at) <= Date.now() || session.device_hash !== input.context.deviceHash) {
    await recordPlaybackSecurityEvent(event, { eventType: 'event_session_rejected', userId: input.userId, sessionId: input.sessionId, seriesId: input.seriesId, episodeNo: input.episodeNo, deviceHash: input.context.deviceHash, ipHash: input.context.ipHash });
    throw createError({ statusCode: 401, statusMessage: 'Playback session is invalid or expired' });
  }
  await d1Run(event, `UPDATE playback_sessions SET ip_hash = ?, user_agent_hash = ?, last_seen_at = ?,
    event_count = event_count + 1 WHERE session_id = ? AND status = 'active'`, [input.context.ipHash, input.context.userAgentHash, new Date().toISOString(), input.sessionId]);
  return session;
};

export const playbackSessionMaxAgeSeconds = sessionMaxAgeSeconds;
