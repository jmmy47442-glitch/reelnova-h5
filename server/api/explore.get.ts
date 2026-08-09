import { seriesList } from '~/data/mock';
import { ok } from '~/server/utils/response';
import { hydrateSeriesRuntimeData } from '~/server/utils/series-runtime';

export default defineEventHandler(async (event) => {
  const query = getQuery(event);
  let result = [...seriesList];
  if (query.q) {
    const term = String(query.q).toLowerCase();
    result = result.filter((series) => `${series.title} ${series.cast.join(' ')} ${series.genres.join(' ')}`.toLowerCase().includes(term));
  }
  return ok(await hydrateSeriesRuntimeData(event, result));
});
