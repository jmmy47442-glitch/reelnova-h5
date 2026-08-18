import { d1First } from '~/server/utils/cloudflare-d1';
import { createStreamManifestUrl, createStreamPlaybackToken } from '~/server/utils/media-pipeline';

export default defineEventHandler(async (event) => {
  const assetId = getRouterParam(event, 'assetId') || '';
  const asset = await d1First<{ stream_uid: string; hls_url: string | null; status: string }>(event,
    'SELECT stream_uid, hls_url, status FROM media_assets WHERE id = ? AND deleted_at IS NULL', [assetId]);
  if (!asset || asset.status !== 'ready' || !asset.stream_uid) throw createError({ statusCode: 404, statusMessage: 'Preview is not ready' });
  const customerCode = String(useRuntimeConfig(event).cloudflareStreamCustomerCode || '');
  if (!asset.hls_url && !customerCode) throw createError({ statusCode: 503, statusMessage: 'Cloudflare Stream delivery URL is not configured' });
  const token = await createStreamPlaybackToken(event, asset.stream_uid);
  return sendRedirect(event, createStreamManifestUrl(asset.stream_uid, token, asset.hls_url, customerCode) || '/', 302);
});
