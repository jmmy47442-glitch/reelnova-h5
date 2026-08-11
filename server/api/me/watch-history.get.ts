import { ok } from '~/server/utils/response';
import { hydrateSeriesRuntimeData } from '~/server/utils/series-runtime';
import { getPublicSeries } from '~/server/utils/managed-content';
import { getUserSession } from '~/server/utils/user-auth';
import type { WatchHistoryItem } from '~/types/content';

export default defineEventHandler(async (event) => {
  const session = await getUserSession(event);
  if (!session) throw createError({ statusCode: 401, statusMessage: 'Login required' });
  const hydrated = await hydrateSeriesRuntimeData(event, await getPublicSeries(event));
  const items = hydrated
    .filter((series): series is WatchHistoryItem => Boolean(series.currentEpisode && series.lastWatchedAt))
    .sort((left, right) => right.lastWatchedAt.localeCompare(left.lastWatchedAt));
  return ok(items);
});
