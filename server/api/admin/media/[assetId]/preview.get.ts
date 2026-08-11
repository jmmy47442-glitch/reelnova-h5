import { d1First } from '~/server/utils/cloudflare-d1';
import { createStreamPlaybackToken } from '~/server/utils/media-pipeline';

export default defineEventHandler(async (event) => {
  const assetId = getRouterParam(event, 'assetId') || '';
  const asset = await d1First<{ stream_uid: string; status: string }>(event,
    'SELECT stream_uid, status FROM media_assets WHERE id = ? AND deleted_at IS NULL', [assetId]);
  if (!asset || asset.status !== 'ready' || !asset.stream_uid) throw createError({ statusCode: 404, statusMessage: 'Preview is not ready' });
  const customerCode = String(useRuntimeConfig(event).cloudflareStreamCustomerCode || '');
  if (!customerCode) throw createError({ statusCode: 503, statusMessage: 'Cloudflare Stream customer code is not configured' });
  const token = await createStreamPlaybackToken(event, asset.stream_uid);
  return sendRedirect(event, `https://customer-${customerCode}.cloudflarestream.com/${token}/manifest/video.m3u8`, 302);
});
