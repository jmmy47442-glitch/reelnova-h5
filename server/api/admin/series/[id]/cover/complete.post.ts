import { ok } from '~/server/utils/response';
import { recordAdminAudit } from '~/server/utils/admin-audit';
import { updateManagedSeriesCoverRecord, toAdminSeries } from '~/server/utils/managed-content';
import { mediaWorkerRequest, requireMediaPipeline } from '~/server/utils/media-pipeline';

interface VerifiedImage {
  objectKey: string;
  publicUrl: string;
  contentType: string;
  size: number;
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export default defineEventHandler(async (event) => {
  requireMediaPipeline(event);
  const seriesId = getRouterParam(event, 'id') || '';
  const body = await readBody<{ objectKey?: unknown }>(event);
  const objectKey = String(body?.objectKey || '').trim();
  const expectedKey = new RegExp(`^posters/${escapeRegExp(seriesId)}/cover-[0-9a-f-]{36}\\.(?:jpg|png|webp)$`, 'i');
  if (!seriesId || !expectedKey.test(objectKey)) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid series cover object key' });
  }

  const verified = await mediaWorkerRequest<VerifiedImage>(event, '/images/verify', { objectKey, seriesId });
  const item = await updateManagedSeriesCoverRecord(event, seriesId, verified.publicUrl);
  await recordAdminAudit(event, {
    module: '短剧管理',
    action: '更新封面',
    target: item.title,
    detail: `${verified.contentType} · ${verified.size} bytes`,
  });
  return ok(toAdminSeries(item));
});
