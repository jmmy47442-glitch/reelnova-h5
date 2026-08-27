import { ok } from '~/server/utils/response';
import { recordAdminAudit } from '~/server/utils/admin-audit';
import { reorderManagedEpisodeRecords } from '~/server/utils/managed-content';

export default defineEventHandler(async (event) => {
  const seriesId = getRouterParam(event, 'id') || '';
  const body = await readBody<{ episodeIds?: unknown }>(event);
  if (!Array.isArray(body?.episodeIds) || body.episodeIds.some((id) => typeof id !== 'string' || !id)) {
    throw createError({ statusCode: 400, statusMessage: 'episodeIds must be an array of episode IDs' });
  }
  const result = await reorderManagedEpisodeRecords(event, seriesId, body.episodeIds);
  await recordAdminAudit(event, {
    module: '短剧管理',
    action: '调整剧集顺序',
    target: result.seriesTitle,
    detail: `已按列表顺序重排 ${result.items.length} 集`,
  });
  return ok({ items: result.items });
});
