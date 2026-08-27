import { ok } from '~/server/utils/response';
import { getManagedEpisodes } from '~/server/utils/managed-content';

export default defineEventHandler(async (event) => {
  const seriesId = getRouterParam(event, 'id') || '';
  return ok({ items: await getManagedEpisodes(event, seriesId), generatedAt: new Date().toISOString() });
});
