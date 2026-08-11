import { ok } from '~/server/utils/response';
import { d1First } from '~/server/utils/cloudflare-d1';
import { assertUserEnabled, upsertUserProfile } from '~/server/utils/user-profile';
import { getUserSession } from '~/server/utils/user-auth';
import { getPublicSeries } from '~/server/utils/managed-content';
import { createStreamPlaybackToken } from '~/server/utils/media-pipeline';

const sign = async (value: string, secret: string) => {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value)));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
};

export default defineEventHandler(async (event) => {
  const requestUrl = getRequestURL(event);
  const origin = getHeader(event, 'origin');
  const referer = getHeader(event, 'referer');
  if (origin && origin !== requestUrl.origin) throw createError({ statusCode: 403, statusMessage: 'Cross-origin playback request denied' });
  if (referer) {
    try { if (new URL(referer).origin !== requestUrl.origin) throw new Error('cross-origin'); }
    catch { throw createError({ statusCode: 403, statusMessage: 'Invalid playback referrer' }); }
  }
  const query = getQuery(event);
  const seriesList = await getPublicSeries(event);
  const series = seriesList.find((item) => item.id === query.seriesId);
  const episode = series?.episodes.find((item) => item.episodeNo === Number(query.episodeNo));
  if (!series || !episode) throw createError({ statusCode: 404, statusMessage: 'Episode not found' });
  const userSession = await getUserSession(event);
  if (!userSession) throw createError({ statusCode: 401, statusMessage: 'Login required' });
  const userId = userSession.userId;
  const sessionId = String(query.sessionId || '');
  if (!sessionId || sessionId.length > 100) throw createError({ statusCode: 400, statusMessage: 'Playback session is required' });
  await upsertUserProfile(event, { userId });
  await assertUserEnabled(event, userId);
  if (!episode.isFree) {
    const entitlement = await d1First<{ status: string }>(event, `SELECT status FROM (
      SELECT series_id, status FROM entitlements WHERE user_id = ?
      UNION ALL
      SELECT series_id, status FROM manual_entitlements WHERE user_id = ?
    ) WHERE series_id = ? AND status = 'granted' LIMIT 1`, [userId, userId, series.id]);
    if (!entitlement) throw createError({ statusCode: 403, statusMessage: 'Entitlement required' });
  }
  const lastProgress = await d1First<{ position_seconds: number; duration_seconds: number }>(event,
    `SELECT position_seconds, duration_seconds FROM playback_events
     WHERE user_id = ? AND series_id = ? AND episode_no = ? AND event_type IN ('heartbeat', 'complete')
     ORDER BY created_at DESC LIMIT 1`, [userId, series.id, episode.episodeNo]);
  const config = useRuntimeConfig(event);
  const streamAsset = await d1First<{ stream_uid: string }>(event, `SELECT a.stream_uid FROM media_assets a
    JOIN episodes e ON e.active_media_asset_id = a.id
    WHERE e.series_id = ? AND e.episode_no = ? AND e.deleted_at IS NULL AND a.status = 'ready' LIMIT 1`,
  [series.id, episode.episodeNo]).catch(() => null);
  const customerCode = String(config.cloudflareStreamCustomerCode || '');
  const mediaBaseUrl = String(config.cloudflareMediaBaseUrl || '').replace(/\/$/, '');
  const signingSecret = String(config.cloudflareMediaSigningSecret || '');
  if (!signingSecret || ((!streamAsset?.stream_uid || !customerCode) && !mediaBaseUrl)) throw createError({ statusCode: 503, statusMessage: 'Cloudflare media delivery is not configured' });
  const expires = Math.floor(Date.now() / 1000) + 10 * 60;
  const path = `/hls/${series.id}/${episode.episodeNo}/master.m3u8`;
  const signature = await sign(`${path}:${userId}:${expires}`, signingSecret);
  const trackingSignature = await sign(`track:${userId}:${sessionId}:${series.id}:${episode.episodeNo}:${expires}`, signingSecret);
  const signedUrl = streamAsset?.stream_uid && customerCode
    ? `https://customer-${customerCode}.cloudflarestream.com/${await createStreamPlaybackToken(event, streamAsset.stream_uid)}/manifest/video.m3u8`
    : `${mediaBaseUrl}${path}?user=${encodeURIComponent(userId)}&expires=${expires}&signature=${signature}`;
  return ok({ authorized: true, signedUrl, expiresAt: new Date(expires * 1000).toISOString(), trackingToken: `${expires}.${trackingSignature}`, resumePositionSeconds: Math.max(0, Number(lastProgress?.position_seconds || 0)), resumeDurationSeconds: Math.max(0, Number(lastProgress?.duration_seconds || 0)) });
});
