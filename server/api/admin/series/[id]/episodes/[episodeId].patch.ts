import { ok } from '~/server/utils/response';
import { recordAdminAudit } from '~/server/utils/admin-audit';
import { updateManagedEpisodeAccess } from '~/server/utils/managed-content';

export default defineEventHandler(async (event) => {
  const seriesId = getRouterParam(event, 'id') || '';
  const episodeId = getRouterParam(event, 'episodeId') || '';
  const body = await readBody<{ isFree?: unknown }>(event);
  if (typeof body?.isFree !== 'boolean') {
    throw createError({ statusCode: 400, statusMessage: 'isFree must be a boolean' });
  }
  const result = await updateManagedEpisodeAccess(event, seriesId, episodeId, body.isFree);
  await recordAdminAudit(event, {
    module: '短剧管理',
    action: body.isFree ? '设置剧集试看' : '设置剧集收费',
    target: `${result.seriesTitle} · Episode ${result.episode.episodeNo}`,
    detail: body.isFree ? '该集可免费观看' : '该集需要解锁后观看',
  });
  return ok(result.episode);
});
