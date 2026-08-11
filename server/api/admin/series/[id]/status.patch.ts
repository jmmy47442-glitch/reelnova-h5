import { ok } from '~/server/utils/response';
import { recordAdminAudit } from '~/server/utils/admin-audit';
import { isPublishStatus } from '~/server/utils/admin-content-input';
import { getManagedSeries, saveManagedSeries, toAdminSeries } from '~/server/utils/managed-content';

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id') || '';
  const body = await readBody<{ publishStatus?: unknown }>(event);
  if (!isPublishStatus(body?.publishStatus)) throw createError({ statusCode: 400, statusMessage: 'Invalid publish status' });
  const items = await getManagedSeries(event);
  const item = items.find((entry) => entry.id === id);
  if (!item) throw createError({ statusCode: 404, statusMessage: 'Series not found' });
  if (body.publishStatus === '已上架' && (!item.episodeCount || item.transcodeProgress < 100)) {
    throw createError({ statusCode: 409, statusMessage: 'Episodes must finish transcoding before publishing' });
  }
  const before = item.publishStatus;
  item.publishStatus = body.publishStatus;
  item.publishAt = new Date().toISOString().slice(0, 10);
  await saveManagedSeries(event, items);
  await recordAdminAudit(event, {
    module: '短剧管理',
    action: body.publishStatus === '已上架' ? '上架短剧' : '变更发布状态',
    target: item.title,
    detail: `${before} → ${body.publishStatus}`,
    risk: ['已下架', '版权冻结'].includes(body.publishStatus) ? '高风险' : '普通',
  });
  return ok(toAdminSeries(item));
});
