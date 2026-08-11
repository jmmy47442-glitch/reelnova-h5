import { ok } from '~/server/utils/response';
import { recordAdminAudit } from '~/server/utils/admin-audit';
import { duplicateManagedSeriesRecord, getManagedSeries, toAdminSeries } from '~/server/utils/managed-content';

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id') || '';
  const items = await getManagedSeries(event);
  const source = items.find((entry) => entry.id === id);
  if (!source) throw createError({ statusCode: 404, statusMessage: 'Series not found' });
  const copy = await duplicateManagedSeriesRecord(event, id);
  await recordAdminAudit(event, { module: '短剧管理', action: '复制短剧', target: copy.title, detail: `来源：${source.id}` });
  return ok(toAdminSeries(copy));
});
