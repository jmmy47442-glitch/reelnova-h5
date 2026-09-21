import type { H3Event } from 'h3';
import { ok } from '~/server/utils/response';
import { d1First, hasD1Connection } from '~/server/utils/cloudflare-d1';
import { assertUserEnabled, upsertUserProfile } from '~/server/utils/user-profile';
import { getUserSession } from '~/server/utils/user-auth';
import { getPublicSeries } from '~/server/utils/managed-content';
import { mediaWorkerRequest } from '~/server/utils/media-pipeline';
import { getPlaybackAuthorizationSecret, signPlaybackAuthorization } from '~/server/utils/playback-authorization';
import { enforcePlaybackRateLimits, establishPlaybackSession, getPlaybackClientContext } from '~/server/utils/playback-security';

type PlaybackAsset = {
  id: string;
  storage_provider: string;
  source_object_key: string | null;
  source_content_type: string | null;
  stream_uid: string | null;
  hls_url: string | null;
};

const cloudflareStreamHlsUrl = (asset: PlaybackAsset) => {
  if (asset.storage_provider !== 'stream' || !/^[a-f0-9]{32}$/i.test(asset.stream_uid || '')) return null;
  try {
    const url = new URL(asset.hls_url || '');
    if (url.protocol !== 'https:' || !/^customer-[a-z0-9]+\.cloudflarestream\.com$/i.test(url.hostname)
      || url.pathname !== `/${asset.stream_uid}/manifest/video.m3u8` || url.search || url.hash) return null;
    return url.href;
  } catch { return null; }
};

const createCloudflareStreamPlaybackUrl = async (event: H3Event, manifestUrl: string) => {
  const config = useRuntimeConfig(event);
  const env = (event.context.cloudflare as { env?: { CLOUDFLARE_ACCOUNT_ID?: string; CLOUDFLARE_API_TOKEN?: string } } | undefined)?.env;
  const accountId = String(config.cloudflareAccountId || env?.CLOUDFLARE_ACCOUNT_ID || '');
  const apiToken = String(config.cloudflareApiToken || env?.CLOUDFLARE_API_TOKEN || '');
  if (!accountId || !apiToken) throw createError({ statusCode: 503, statusMessage: 'Cloudflare Stream signing is not configured' });
  const assetUid = new URL(manifestUrl).pathname.split('/')[1];
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/stream/${encodeURIComponent(assetUid)}/token`, {
    method: 'POST', body: '{}', signal: AbortSignal.timeout(10000),
    headers: { authorization: `Bearer ${apiToken}`, 'content-type': 'application/json' },
  });
  const payload = await response.json().catch(() => ({})) as { success?: boolean; result?: { token?: string }; errors?: Array<{ message?: string }> };
  const token = String(payload.result?.token || '');
  if (!response.ok || !payload.success || !/^[A-Za-z0-9._-]{20,4096}$/.test(token)) {
    throw createError({ statusCode: 502, statusMessage: payload.errors?.[0]?.message || 'Cloudflare Stream token request failed' });
  }
  const signed = new URL(manifestUrl);
  signed.pathname = `/${token}/manifest/video.m3u8`;
  return signed.href;
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
  const seriesId = String(query.seriesId || '');
  const seriesSlug = String(query.seriesSlug || '');
  const episodeNo = Number(query.episodeNo);
  if ((!seriesId && !seriesSlug) || (seriesId && seriesSlug) || !Number.isInteger(episodeNo) || episodeNo < 1) {
    throw createError({ statusCode: 400, statusMessage: 'A valid series and episode are required' });
  }

  // Playback used to load the complete public catalogue (four D1 queries) and
  // then search it in memory. The player only needs one published episode and
  // its active asset, so keep this hot path to a single indexed query.
  let series: { id: string; title: string };
  let episode: { episodeNo: number; isFree: boolean; videoStatus: string };
  let mediaAsset: PlaybackAsset | null = null;
  const userSessionPromise = getUserSession(event);
  if (hasD1Connection(event)) {
    const seriesSelector = seriesId ? 's.id = ?' : 's.slug = ?';
    const seriesIdentifier = seriesId || seriesSlug;
    const row = await d1First<{ series_id: string; series_title: string; episode_no: number; is_free: number; video_status: string; asset_id: string | null; storage_provider: string | null; source_object_key: string | null; source_content_type: string | null; stream_uid: string | null; hls_url: string | null }>(event,
      `SELECT s.id AS series_id, s.title AS series_title, e.episode_no, e.is_free, e.video_status,
        a.id AS asset_id, a.storage_provider, a.source_object_key, a.source_content_type, a.stream_uid, a.hls_url
       FROM series s
       JOIN episodes e ON e.series_id = s.id AND e.deleted_at IS NULL
       LEFT JOIN media_assets a ON a.id = e.active_media_asset_id AND a.status = 'ready' AND a.deleted_at IS NULL
       WHERE ${seriesSelector} AND s.status = 'published' AND s.deleted_at IS NULL AND e.episode_no = ?
       LIMIT 1`, [seriesIdentifier, episodeNo]);
    if (!row) throw createError({ statusCode: 404, statusMessage: 'Episode not found' });
    series = { id: row.series_id, title: row.series_title };
    episode = { episodeNo: row.episode_no, isFree: Boolean(row.is_free), videoStatus: row.video_status };
    mediaAsset = row.asset_id ? { id: row.asset_id, storage_provider: row.storage_provider || '',
      source_object_key: row.source_object_key, source_content_type: row.source_content_type,
      stream_uid: row.stream_uid, hls_url: row.hls_url } : null;
  } else {
    const seriesList = await getPublicSeries(event);
    const localSeries = seriesList.find((item) => seriesId ? item.id === seriesId : item.slug === seriesSlug);
    const localEpisode = localSeries?.episodes.find((item) => item.episodeNo === episodeNo);
    if (!localSeries || !localEpisode) throw createError({ statusCode: 404, statusMessage: 'Episode not found' });
    series = localSeries;
    episode = { episodeNo: localEpisode.episodeNo, isFree: localEpisode.isFree, videoStatus: localEpisode.mediaStatus || 'ready' };
  }
  const userSession = await userSessionPromise;
  if (!userSession && !episode.isFree) throw createError({ statusCode: 401, statusMessage: 'Login required to unlock paid episodes' });
  const userId = userSession?.userId;
  const sessionId = String(query.sessionId || '');
  if (!sessionId || sessionId.length > 100) throw createError({ statusCode: 400, statusMessage: 'Playback session is required' });
  const playbackContext = await getPlaybackClientContext(event);
  await enforcePlaybackRateLimits(event, playbackContext, userId || `guest:${playbackContext.deviceHash}`, sessionId);
  const entitlementPromise = episode.isFree
    ? Promise.resolve({ status: 'free' })
    : d1First<{ status: string }>(event, `SELECT status FROM (
      SELECT series_id, status FROM entitlements WHERE user_id = ?
      UNION ALL
      SELECT series_id, status FROM manual_entitlements WHERE user_id = ?
    ) WHERE series_id = ? AND status = 'granted' LIMIT 1`, [userId!, userId!, series.id]);
  const lastProgressPromise = userId && hasD1Connection(event)
    ? d1First<{ position_seconds: number; duration_seconds: number; completed: number }>(event,
      `SELECT position_seconds, duration_seconds, completed FROM watch_history
       WHERE user_id = ? AND series_id = ? AND episode_no = ? LIMIT 1`, [userId, series.id, episode.episodeNo])
    : null;
  const [, , entitlement, lastProgress] = await Promise.all([
    userId ? upsertUserProfile(event, { userId }) : Promise.resolve(),
    userId ? assertUserEnabled(event, userId) : Promise.resolve(),
    entitlementPromise,
    lastProgressPromise,
  ]);
  if (!entitlement) throw createError({ statusCode: 403, statusMessage: 'Entitlement required' });
  const streamHlsUrl = mediaAsset ? cloudflareStreamHlsUrl(mediaAsset) : null;
  if (!mediaAsset || episode.videoStatus !== 'ready'
    || (mediaAsset.storage_provider === 'stream' ? !streamHlsUrl : !mediaAsset.source_object_key)) {
    throw createError({ statusCode: 503, statusMessage: 'Video playback is not ready' });
  }
  const trackingSecret = getPlaybackAuthorizationSecret(event);
  const expires = Math.floor(Date.now() / 1000) + 10 * 60;
  if (userId) await establishPlaybackSession(event, { sessionId, userId, seriesId: series.id, episodeNo: episode.episodeNo, context: playbackContext });
  const [trackingSignature, original] = await Promise.all([
    userId
      ? signPlaybackAuthorization(`track:${userId}:${sessionId}:${series.id}:${episode.episodeNo}:${expires}`, trackingSecret)
      : Promise.resolve(''),
    streamHlsUrl ? createCloudflareStreamPlaybackUrl(event, streamHlsUrl).then(url => ({ url, delivery: 'hls' as const,
      originalUrl: undefined, prefetchUrls: undefined, rendition: undefined })) : mediaWorkerRequest<{ url: string; originalUrl?: string; delivery?: 'hls' | 'mp4'; prefetchUrls?: string[]; rendition?: 'original' | 'mobile' }>(event, '/original/token', {
      key: mediaAsset.source_object_key, assetId: mediaAsset.id, exp: expires, delivery: 'auto',
      profile: query.profile === 'mobile' || getHeader(event, 'save-data') === 'on' ? 'mobile' : 'original',
      prewarm: query.prewarm === 'true',
    }),
  ]);
  setHeader(event, 'cache-control', 'no-store');
  return ok({ authorized: true, signedUrl: original.url, originalUrl: original.delivery === 'hls' ? original.originalUrl : original.url, delivery: original.delivery || 'mp4', prefetchUrls: original.prefetchUrls, rendition: original.rendition || 'original', expiresAt: new Date(expires * 1000).toISOString(), trackingToken: userId ? `${expires}.${trackingSignature}` : '',
    // A completed episode should start from the beginning on the next visit.
    resumePositionSeconds: lastProgress?.completed ? 0 : Math.max(0, Number(lastProgress?.position_seconds || 0)),
    resumeDurationSeconds: Math.max(0, Number(lastProgress?.duration_seconds || 0)) });
});
