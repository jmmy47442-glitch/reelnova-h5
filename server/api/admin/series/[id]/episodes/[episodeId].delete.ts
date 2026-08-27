import { ok } from '~/server/utils/response';
import { recordAdminAudit } from '~/server/utils/admin-audit';
import { deleteManagedEpisodeRecord } from '~/server/utils/managed-content';

export default defineEventHandler(async (event) => {
  const seriesId = getRouterParam(event, 'id') || '';
  const episodeId = getRouterParam(event, 'episodeId') || '';
  const result = await deleteManagedEpisodeRecord(event, seriesId, episodeId);
  await recordAdminAudit(event, {
    module: '短剧管理', action: '删除剧集', target: `${result.seriesTitle} · Episode ${result.episodeNo}`,
    detail: `已软删除剧集“${result.title}”及其媒体关联`, risk: '高风险',
  });
  return ok({ id: result.id, episodeNo: result.episodeNo, title: result.title, items: result.items });
});
