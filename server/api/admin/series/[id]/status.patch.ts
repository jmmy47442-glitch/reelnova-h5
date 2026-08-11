import { ok } from '~/server/utils/response';
import { recordAdminAudit } from '~/server/utils/admin-audit';
import { isPublishStatus } from '~/server/utils/admin-content-input';
import { getManagedSeries, updateManagedSeriesStatusRecord, toAdminSeries } from '~/server/utils/managed-content';

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id') || '';
  const body = await readBody<{ publishStatus?: unknown }>(event);
  if (!isPublishStatus(body?.publishStatus)) throw createError({ statusCode: 400, statusMessage: 'Invalid publish status' });
  const items = await getManagedSeries(event);
  const item = items.find((entry) => entry.id === id);
  if (!item) throw createError({ statusCode: 404, statusMessage: 'Series not found' });
  const before = item.publishStatus;
  const updated = await updateManagedSeriesStatusRecord(event, id, body.publishStatus);
  await recordAdminAudit(event, {
    module: '短剧管理',
    action: body.publishStatus === '已上架' ? '上架短剧' : '变更发布状态',
    target: item.title,
    detail: `${before} → ${body.publishStatus}`,
    risk: ['已下架', '版权冻结'].includes(body.publishStatus) ? '高风险' : '普通',
  });
  return ok(toAdminSeries(updated));
});
