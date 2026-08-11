import { ok } from '~/server/utils/response';
import { d1First } from '~/server/utils/cloudflare-d1';
import { listAdminEpisodes, requireMediaPipeline } from '~/server/utils/media-pipeline';

export default defineEventHandler(async (event) => {
  requireMediaPipeline(event);
  const seriesId = getRouterParam(event, 'id') || '';
  if (!await d1First(event, 'SELECT id FROM series WHERE id = ? AND deleted_at IS NULL', [seriesId])) {
    throw createError({ statusCode: 404, statusMessage: 'Series not found' });
  }
  return ok({ items: await listAdminEpisodes(event, seriesId), generatedAt: new Date().toISOString() });
});
