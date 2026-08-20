import { d1First } from '~/server/utils/cloudflare-d1';
import { createStreamPlaybackToken, createStreamThumbnailUrl } from '~/server/utils/media-pipeline';

export default defineEventHandler(async (event) => {
  const seriesId = getRouterParam(event, 'seriesId') || '';
  const variant = getQuery(event).variant === 'backdrop' ? 'backdrop' : 'cover';
  const fallbackUrl = variant === 'backdrop'
    ? '/posters/vows-vengeance-wide.jpg'
    : '/posters/vows-vengeance.jpg';

  try {
    const asset = await d1First<{ stream_uid: string; thumbnail_url: string | null }>(event, `SELECT a.stream_uid, a.thumbnail_url
      FROM series s JOIN episodes e ON e.series_id = s.id
      JOIN media_assets a ON a.id = e.active_media_asset_id
      WHERE s.id = ? AND s.status = 'published' AND s.deleted_at IS NULL
        AND e.deleted_at IS NULL AND a.status = 'ready' AND a.stream_uid IS NOT NULL
      ORDER BY e.episode_no ASC LIMIT 1`, [seriesId]);
    if (!asset) throw new Error('Series poster asset not found');

    const token = await createStreamPlaybackToken(event, asset.stream_uid);
    const url = createStreamThumbnailUrl(
      asset.stream_uid,
      token,
      asset.thumbnail_url,
      String(useRuntimeConfig(event).cloudflareStreamCustomerCode || ''),
      variant,
    );
    if (!url) throw new Error('Stream thumbnail delivery is not configured');

    const response = await fetch(url, { headers: { accept: 'image/avif,image/webp,image/*' } });
    const contentType = response.headers.get('content-type') || '';
    if (!response.ok || !response.body || !contentType.toLowerCase().startsWith('image/')) {
      throw new Error(`Stream thumbnail request failed (${response.status})`);
    }

    setHeader(event, 'content-type', contentType);
    setHeader(event, 'cache-control', 'public, max-age=300, stale-while-revalidate=3600');
    return sendStream(event, response.body);
  } catch {
    setHeader(event, 'cache-control', 'public, max-age=60, stale-while-revalidate=300');
    return sendRedirect(event, fallbackUrl, 302);
  }
});
