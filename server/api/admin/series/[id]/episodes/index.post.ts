import { ok } from '~/server/utils/response';
import { recordAdminAudit } from '~/server/utils/admin-audit';
import { createManagedEpisodeRecord } from '~/server/utils/managed-content';

export default defineEventHandler(async (event) => {
  const seriesId = getRouterParam(event, 'id') || '';
  const body = await readBody<{ title?: unknown }>(event);
  const title = String(body?.title || '').trim();
  if (title.length > 120) throw createError({ statusCode: 400, statusMessage: 'Episode title must not exceed 120 characters' });
  const result = await createManagedEpisodeRecord(event, seriesId, title);
  await recordAdminAudit(event, {
    module: '短剧管理', action: '新增剧集', target: `${result.seriesTitle} · Episode ${result.episode.episodeNo}`,
    detail: result.episode.title,
  });
  return ok(result.episode);
});
