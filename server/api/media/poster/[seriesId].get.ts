import { d1First } from '~/server/utils/cloudflare-d1';
import { createStreamPlaybackToken, createStreamThumbnailUrl } from '~/server/utils/media-pipeline';

export default defineEventHandler(async (event) => {
  const seriesId = getRouterParam(event, 'seriesId') || '';
  const variant = getQuery(event).variant === 'backdrop' ? 'backdrop' : 'cover';
  const asset = await d1First<{ stream_uid: string; thumbnail_url: string | null }>(event, `SELECT a.stream_uid, a.thumbnail_url
    FROM series s JOIN episodes e ON e.series_id = s.id
    JOIN media_assets a ON a.id = e.active_media_asset_id
    WHERE s.id = ? AND s.status = 'published' AND s.deleted_at IS NULL
      AND e.deleted_at IS NULL AND a.status = 'ready' AND a.stream_uid IS NOT NULL
    ORDER BY e.episode_no ASC LIMIT 1`, [seriesId]);
  if (!asset) throw createError({ statusCode: 404, statusMessage: 'Series poster not found' });

  const token = await createStreamPlaybackToken(event, asset.stream_uid);
  const url = createStreamThumbnailUrl(
    asset.stream_uid,
    token,
    asset.thumbnail_url,
    String(useRuntimeConfig(event).cloudflareStreamCustomerCode || ''),
    variant,
  );
  if (!url) throw createError({ statusCode: 503, statusMessage: 'Stream thumbnail delivery is not configured' });
  setHeader(event, 'cache-control', 'public, max-age=300, stale-while-revalidate=300');
  return sendRedirect(event, url, 302);
});
