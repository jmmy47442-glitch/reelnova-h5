import { findSeries } from '~/data/mock';
import { ok } from '~/server/utils/response';
import { hydrateSeriesRuntimeData } from '~/server/utils/series-runtime';

export default defineEventHandler(async (event) => {
  const slug = getRouterParam(event, 'slug') || '';
  const series = findSeries(slug);
  if (!series) throw createError({ statusCode: 404, statusMessage: 'Series not found' });
  return ok((await hydrateSeriesRuntimeData(event, [series]))[0]);
});
