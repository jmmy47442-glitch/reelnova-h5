import { ok } from '~/server/utils/response';
import { recordAdminAudit } from '~/server/utils/admin-audit';
import { parseSeriesInput } from '~/server/utils/admin-content-input';
import { getManagedSeries, updateManagedSeriesRecord, toAdminSeries } from '~/server/utils/managed-content';

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id') || '';
  const input = parseSeriesInput(await readBody(event));
  const current = (await getManagedSeries(event)).find((entry) => entry.id === id);
  if (current && current.episodeCount > input.freeEpisodeCount && input.price <= 0) {
    throw createError({ statusCode: 400, statusMessage: 'Locked episodes require a checkout price greater than zero' });
  }
  const previousTitle = current?.title || id;
  const item = await updateManagedSeriesRecord(event, id, input);
  await recordAdminAudit(event, { module: '短剧管理', action: '编辑短剧', target: item.title, detail: `${previousTitle} · 内容资料已更新` });
  return ok(toAdminSeries(item));
});
