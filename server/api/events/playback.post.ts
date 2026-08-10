import { ok } from '~/server/utils/response';
import { d1Run, getRequestCountry, getVisitorId } from '~/server/utils/cloudflare-d1';
import { assertUserEnabled, upsertUserProfile } from '~/server/utils/user-profile';
import type { PlaybackEventInput } from '~/types/admin';

export default defineEventHandler(async (event) => {
  const body = await readBody<PlaybackEventInput>(event);
  if (!body?.eventId || !body.sessionId || !body.seriesId || !body.seriesTitle || !body.authorizationToken || !Number.isInteger(body.episodeNo) || !['start', 'heartbeat', 'complete'].includes(body.eventType)) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid playback event' });
  }
  const [expiresRaw, suppliedSignature] = body.authorizationToken.split('.', 2);
  const expires = Number(expiresRaw);
  if (!expires || expires < Math.floor(Date.now() / 1000)) throw createError({ statusCode: 401, statusMessage: 'Playback authorization expired' });
  const secret = String(useRuntimeConfig(event).cloudflareMediaSigningSecret || '');
  if (!secret) throw createError({ statusCode: 503, statusMessage: 'Playback signing is not configured' });
  const visitorId = getVisitorId(event);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signed = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`track:${visitorId}:${body.sessionId}:${body.seriesId}:${body.episodeNo}:${expires}`)));
  const expectedSignature = Array.from(signed, (byte) => byte.toString(16).padStart(2, '0')).join('');
  if (suppliedSignature?.length !== expectedSignature.length || !suppliedSignature || !Array.from(expectedSignature).every((character, index) => character === suppliedSignature[index])) {
    throw createError({ statusCode: 401, statusMessage: 'Invalid playback authorization' });
  }
  await upsertUserProfile(event, { visitorId });
  await assertUserEnabled(event, visitorId);
  await d1Run(event, `INSERT OR IGNORE INTO playback_events
    (event_id, session_id, visitor_id, series_id, series_title, episode_no, event_type, position_seconds, duration_seconds, country, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
    body.eventId, body.sessionId, visitorId, body.seriesId, body.seriesTitle, body.episodeNo, body.eventType,
    Math.max(0, Math.round(body.positionSeconds || 0)), Math.max(0, Math.round(body.durationSeconds || 0)), getRequestCountry(event), new Date().toISOString(),
  ]);
  return ok({ accepted: true });
});
