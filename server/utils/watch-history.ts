import type { H3Event } from 'h3';
import type { PlaybackEventInput } from '~/types/content';
import { d1Run, getRequestCountry } from './cloudflare-d1';
import { getUserSession } from './user-auth';
import { assertUserEnabled, upsertUserProfile } from './user-profile';

const eventTypes = ['start', 'heartbeat', 'complete'] as const;

const sign = async (value: string, secret: string) => {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signed = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value)));
  return Array.from(signed, (byte) => byte.toString(16).padStart(2, '0')).join('');
};

const constantTimeEqual = (left: string, right: string) => (
  left.length === right.length && Array.from(left).every((character, index) => character === right[index])
);

const normalizedPosition = (body: PlaybackEventInput) => {
  const duration = Math.max(0, Math.round(body.durationSeconds));
  const requested = Math.max(0, Math.round(body.positionSeconds));
  if (body.eventType === 'complete' && duration > 0) return duration;
  return duration > 0 ? Math.min(requested, duration) : requested;
};

export const persistAuthorizedPlaybackEvent = async (event: H3Event, body: PlaybackEventInput) => {
  const validNumbers = Number.isInteger(body?.episodeNo) && body.episodeNo > 0
    && Number.isFinite(body?.positionSeconds) && body.positionSeconds >= 0
    && Number.isFinite(body?.durationSeconds) && body.durationSeconds >= 0;
  if (!body?.eventId || body.eventId.length > 100 || !body.sessionId || body.sessionId.length > 100
    || !body.seriesId || body.seriesId.length > 100 || !body.seriesTitle || body.seriesTitle.length > 300
    || !body.authorizationToken || !validNumbers || !eventTypes.includes(body.eventType)) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid playback event' });
  }

  const [expiresRaw, suppliedSignature, extra] = body.authorizationToken.split('.');
  const expires = Number(expiresRaw);
  if (!expires || extra || expires < Math.floor(Date.now() / 1000)) {
    throw createError({ statusCode: 401, statusMessage: 'Playback authorization expired' });
  }

  const secret = String(useRuntimeConfig(event).cloudflareMediaSigningSecret || '');
  if (!secret) throw createError({ statusCode: 503, statusMessage: 'Playback signing is not configured' });
  const session = await getUserSession(event);
  if (!session) throw createError({ statusCode: 401, statusMessage: 'Login required' });

  const expectedSignature = await sign(`track:${session.userId}:${body.sessionId}:${body.seriesId}:${body.episodeNo}:${expires}`, secret);
  if (!suppliedSignature || !constantTimeEqual(suppliedSignature, expectedSignature)) {
    throw createError({ statusCode: 401, statusMessage: 'Invalid playback authorization' });
  }

  await upsertUserProfile(event, { userId: session.userId });
  await assertUserEnabled(event, session.userId);

  const now = new Date().toISOString();
  const duration = Math.max(0, Math.round(body.durationSeconds));
  const position = normalizedPosition(body);
  await d1Run(event, `INSERT OR IGNORE INTO playback_events
    (event_id, session_id, user_id, series_id, series_title, episode_no, event_type, position_seconds, duration_seconds, country, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
    body.eventId, body.sessionId, session.userId, body.seriesId, body.seriesTitle, body.episodeNo,
    body.eventType, position, duration, getRequestCountry(event), now,
  ]);
  await d1Run(event, `INSERT INTO watch_history
    (user_id, series_id, episode_no, position_seconds, duration_seconds, completed, last_event_type, last_watched_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, series_id) DO UPDATE SET
      episode_no = excluded.episode_no,
      position_seconds = excluded.position_seconds,
      duration_seconds = excluded.duration_seconds,
      completed = excluded.completed,
      last_event_type = excluded.last_event_type,
      last_watched_at = excluded.last_watched_at,
      updated_at = excluded.updated_at`, [
    session.userId, body.seriesId, body.episodeNo, position, duration, body.eventType === 'complete' ? 1 : 0,
    body.eventType, now, now, now,
  ]);

  return { accepted: true as const, positionSeconds: position, durationSeconds: duration, lastWatchedAt: now };
};
