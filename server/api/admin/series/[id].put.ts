import { ok } from '~/server/utils/response';
import { recordAdminAudit } from '~/server/utils/admin-audit';
import { parseSeriesInput } from '~/server/utils/admin-content-input';
import { getManagedSeries, saveManagedSeries, toAdminSeries } from '~/server/utils/managed-content';

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id') || '';
  const input = parseSeriesInput(await readBody(event));
  const items = await getManagedSeries(event);
  const item = items.find((entry) => entry.id === id);
  if (!item) throw createError({ statusCode: 404, statusMessage: 'Series not found' });
  const previousTitle = item.title;
  Object.assign(item, input, { genres: [...input.genres], publishAt: new Date().toISOString().slice(0, 10) });
  item.episodes = item.episodes.map((episode) => ({ ...episode, isFree: episode.episodeNo <= item.freeEpisodeCount }));
  await saveManagedSeries(event, items);
  await recordAdminAudit(event, { module: '短剧管理', action: '编辑短剧', target: item.title, detail: `${previousTitle} · 内容资料已更新` });
  return ok(toAdminSeries(item));
});
