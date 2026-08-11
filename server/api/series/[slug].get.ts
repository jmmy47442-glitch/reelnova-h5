import { ok } from '~/server/utils/response';
import { hydrateSeriesRuntimeData } from '~/server/utils/series-runtime';
import { getPublicSeries } from '~/server/utils/managed-content';

export default defineEventHandler(async (event) => {
  const slug = getRouterParam(event, 'slug') || '';
  const series = (await getPublicSeries(event)).find((item) => item.slug === slug);
  if (!series) throw createError({ statusCode: 404, statusMessage: 'Series not found' });
  return ok((await hydrateSeriesRuntimeData(event, [series]))[0]);
});
