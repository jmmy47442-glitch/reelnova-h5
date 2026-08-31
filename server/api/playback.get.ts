import { ok } from '~/server/utils/response';
import { d1First, hasD1Connection } from '~/server/utils/cloudflare-d1';
import { assertUserEnabled, upsertUserProfile } from '~/server/utils/user-profile';
import { getUserSession } from '~/server/utils/user-auth';
import { getPublicSeries } from '~/server/utils/managed-content';
import { createStreamManifestUrl, createStreamPlaybackToken } from '~/server/utils/media-pipeline';
import { getPlaybackAuthorizationSecret, signPlaybackAuthorization } from '~/server/utils/playback-authorization';
import { enforcePlaybackRateLimits, establishPlaybackSession, getPlaybackClientContext } from '~/server/utils/playback-security';

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
  const episodeNo = Number(query.episodeNo);
  if (!seriesId || !Number.isInteger(episodeNo) || episodeNo < 1) {
    throw createError({ statusCode: 400, statusMessage: 'A valid series and episode are required' });
  }

  // Playback used to load the complete public catalogue (four D1 queries) and
  // then search it in memory. The player only needs one published episode and
  // its active asset, so keep this hot path to a single indexed query.
  let series: { id: string; title: string };
  let episode: { episodeNo: number; isFree: boolean; videoStatus: string };
  let streamAsset: { stream_uid: string | null; hls_url: string | null } | null = null;
  if (hasD1Connection(event)) {
    const row = await d1First<{ series_id: string; series_title: string; episode_no: number; is_free: number; video_status: string; stream_uid: string | null; hls_url: string | null }>(event,
      `SELECT s.id AS series_id, s.title AS series_title, e.episode_no, e.is_free, e.video_status,
        a.stream_uid, a.hls_url
       FROM series s
       JOIN episodes e ON e.series_id = s.id AND e.deleted_at IS NULL
       LEFT JOIN media_assets a ON a.id = e.active_media_asset_id AND a.status = 'ready'
       WHERE s.id = ? AND s.status = 'published' AND s.deleted_at IS NULL AND e.episode_no = ?
       LIMIT 1`, [seriesId, episodeNo]);
    if (!row) throw createError({ statusCode: 404, statusMessage: 'Episode not found' });
    series = { id: row.series_id, title: row.series_title };
    episode = { episodeNo: row.episode_no, isFree: Boolean(row.is_free), videoStatus: row.video_status };
    streamAsset = { stream_uid: row.stream_uid, hls_url: row.hls_url };
  } else {
    const seriesList = await getPublicSeries(event);
    const localSeries = seriesList.find((item) => item.id === seriesId);
    const localEpisode = localSeries?.episodes.find((item) => item.episodeNo === episodeNo);
    if (!localSeries || !localEpisode) throw createError({ statusCode: 404, statusMessage: 'Episode not found' });
    series = localSeries;
    episode = { episodeNo: localEpisode.episodeNo, isFree: localEpisode.isFree, videoStatus: localEpisode.mediaStatus || 'ready' };
  }
  const userSession = await getUserSession(event);
  if (!userSession) throw createError({ statusCode: 401, statusMessage: 'Login required' });
  const userId = userSession.userId;
  const sessionId = String(query.sessionId || '');
  if (!sessionId || sessionId.length > 100) throw createError({ statusCode: 400, statusMessage: 'Playback session is required' });
  const playbackContext = await getPlaybackClientContext(event);
  await enforcePlaybackRateLimits(event, playbackContext, userId, sessionId);
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
  const lastProgress = hasD1Connection(event)
    ? await d1First<{ position_seconds: number; duration_seconds: number; completed: number }>(event,
      `SELECT position_seconds, duration_seconds, completed FROM watch_history
       WHERE user_id = ? AND series_id = ? AND episode_no = ? LIMIT 1`, [userId, series.id, episode.episodeNo])
    : null;
  const config = useRuntimeConfig(event);
  const customerCode = String(config.cloudflareStreamCustomerCode || '');
  const hasStreamSource = Boolean(streamAsset?.stream_uid && (streamAsset.hls_url || customerCode));
  if (!hasStreamSource) throw createError({ statusCode: 503, statusMessage: 'Cloudflare Stream signed delivery is not configured' });
  const trackingSecret = getPlaybackAuthorizationSecret(event);
  const expires = Math.floor(Date.now() / 1000) + 10 * 60;
  await establishPlaybackSession(event, { sessionId, userId, seriesId: series.id, episodeNo: episode.episodeNo, context: playbackContext });
  const trackingSignature = await signPlaybackAuthorization(`track:${userId}:${sessionId}:${series.id}:${episode.episodeNo}:${expires}`, trackingSecret);
  const streamToken = await createStreamPlaybackToken(event, streamAsset!.stream_uid!);
  const signedUrl = createStreamManifestUrl(streamAsset!.stream_uid!, streamToken, streamAsset!.hls_url, customerCode);
  if (!signedUrl) throw createError({ statusCode: 503, statusMessage: 'Cloudflare Stream signed delivery is not configured' });
  return ok({ authorized: true, signedUrl, expiresAt: new Date(expires * 1000).toISOString(), trackingToken: `${expires}.${trackingSignature}`,
    // A completed episode should start from the beginning on the next visit.
    // Keeping its terminal heartbeat here sends HLS clients straight to the
    // final fragment, where a stale/incomplete buffer can fail to decode.
    resumePositionSeconds: lastProgress?.completed ? 0 : Math.max(0, Number(lastProgress?.position_seconds || 0)),
    resumeDurationSeconds: Math.max(0, Number(lastProgress?.duration_seconds || 0)) });
});
