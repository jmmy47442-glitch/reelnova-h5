import { ok } from '~/server/utils/response';
import { hydrateSeriesRuntimeData } from '~/server/utils/series-runtime';
import { getPublicSeries } from '~/server/utils/managed-content';
import { getUserSession } from '~/server/utils/user-auth';

export default defineEventHandler(async (event) => {
  const seriesList = await getPublicSeries(event);
  const userSession = await getUserSession(event);
  if (!userSession) throw createError({ statusCode: 401, statusMessage: 'Login required' });
  const hydrated = await hydrateSeriesRuntimeData(event, seriesList);
  const continueWatching = hydrated
    .filter((series) => series.currentEpisode && series.lastWatchedAt)
    .sort((left, right) => String(right.lastWatchedAt).localeCompare(String(left.lastWatchedAt)));
  return ok({ continueWatching, purchased: hydrated.filter((series) => series.purchased) });
});
