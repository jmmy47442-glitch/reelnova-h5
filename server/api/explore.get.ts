import { ok } from '~/server/utils/response';
import { hydrateSeriesRuntimeData } from '~/server/utils/series-runtime';
import { getPublicSeries } from '~/server/utils/managed-content';

export default defineEventHandler(async (event) => {
  const query = getQuery(event);
  let result = await getPublicSeries(event);
  if (query.q) {
    const term = String(query.q).toLowerCase();
    result = result.filter((series) => `${series.title} ${series.cast.join(' ')} ${series.genres.join(' ')}`.toLowerCase().includes(term));
  }
  return ok(await hydrateSeriesRuntimeData(event, result));
});
