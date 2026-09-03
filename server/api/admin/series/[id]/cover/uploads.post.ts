import { ok } from '~/server/utils/response';
import { d1First } from '~/server/utils/cloudflare-d1';
import { mediaWorkerRequest, requireMediaPipeline } from '~/server/utils/media-pipeline';

const allowedTypes = new Map([
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
]);
const maximumCoverBytes = 10 * 1024 * 1024;

interface WorkerImageUpload {
  objectKey: string;
  uploadUrl: string;
  uploadToken: string;
  expiresAt: string;
}

export default defineEventHandler(async (event) => {
  requireMediaPipeline(event);
  const seriesId = getRouterParam(event, 'id') || '';
  const series = await d1First<{ id: string }>(event,
    'SELECT id FROM series WHERE id = ? AND deleted_at IS NULL', [seriesId]);
  if (!series) throw createError({ statusCode: 404, statusMessage: 'Series not found' });

  const body = await readBody<{ fileName?: unknown; contentType?: unknown; fileSizeBytes?: unknown }>(event);
  const fileName = String(body?.fileName || '').trim();
  const contentType = String(body?.contentType || '').trim().toLowerCase();
  const fileSizeBytes = Number(body?.fileSizeBytes);
  const extension = allowedTypes.get(contentType);
  if (!fileName || fileName.length > 240 || !extension || !Number.isSafeInteger(fileSizeBytes)
    || fileSizeBytes <= 0 || fileSizeBytes > maximumCoverBytes) {
    throw createError({ statusCode: 400, statusMessage: '仅支持不超过 10 MB 的 JPG、PNG 或 WebP 图片' });
  }

  const objectKey = `posters/${seriesId}/cover-${crypto.randomUUID()}.${extension}`;
  const upload = await mediaWorkerRequest<WorkerImageUpload>(event, '/images/uploads', {
    objectKey,
    seriesId,
    contentType,
    fileSizeBytes,
  });
  return ok(upload);
});
