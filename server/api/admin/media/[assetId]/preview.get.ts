import { d1First } from '~/server/utils/cloudflare-d1';
import { mediaWorkerRequest } from '~/server/utils/media-pipeline';
import { ok } from '~/server/utils/response';

export default defineEventHandler(async (event) => {
  const assetId = getRouterParam(event, 'assetId') || '';
  const asset = await d1First<{ source_object_key: string; status: string }>(event,
    'SELECT source_object_key, status FROM media_assets WHERE id = ? AND deleted_at IS NULL', [assetId]);
  if (!asset?.source_object_key || asset.status !== 'ready') throw createError({ statusCode: 404, statusMessage: 'Preview is not ready' });
  const grant = await mediaWorkerRequest<{ url: string; delivery?: 'mp4' | 'hls' }>(event, '/original/token', {
    key: asset.source_object_key, assetId, delivery: 'auto', exp: Math.floor(Date.now() / 1000) + 600,
  });
  setHeader(event, 'cache-control', 'no-store');
  if (getQuery(event).format === 'json') return ok({ url: grant.url, delivery: grant.delivery || 'mp4' });
  return sendRedirect(event, grant.url, 302);
});
