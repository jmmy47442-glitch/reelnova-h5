import { d1First } from '~/server/utils/cloudflare-d1';

export default defineEventHandler(async (event) => {
  const seriesId = getRouterParam(event, 'seriesId') || '';
  const backdrop = getQuery(event).variant === 'backdrop';
  const series = await d1First<{ cover_url: string; backdrop_url: string }>(event,
    "SELECT cover_url, backdrop_url FROM series WHERE id = ? AND status = 'published' AND deleted_at IS NULL", [seriesId]);
  const image = (backdrop ? series?.backdrop_url : series?.cover_url) || '';
  const fallback = backdrop ? '/posters/vows-vengeance-wide.jpg' : '/posters/vows-vengeance.jpg';
  setHeader(event, 'cache-control', 'public, max-age=60');
  // Covers are uploaded independently; never request a Stream thumbnail.
  return sendRedirect(event, image && !image.includes('/api/media/poster/')
    && !/cloudflarestream|videodelivery/i.test(image) && (/^https:\/\//.test(image) || /^\/(?!\/)/.test(image)) ? image : fallback, 302);
});
