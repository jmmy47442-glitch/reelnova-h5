import { ok } from '~/server/utils/response';
import { hydrateSeriesRuntimeData } from '~/server/utils/series-runtime';
import { getPublicSeries, getTaxonomyConfig } from '~/server/utils/managed-content';
import { getSeriesBusinessMetrics } from '~/server/utils/content-ranking';

export default defineEventHandler(async (event) => {
  const query = getQuery(event);
  let result = await getPublicSeries(event);
  const taxonomy = await getTaxonomyConfig(event);
  if (query.q) {
    const term = String(query.q).toLowerCase();
    result = result.filter((series) => `${series.title} ${series.cast.join(' ')} ${series.genres.join(' ')}`.toLowerCase().includes(term));
  }
  if (query.genre) {
    const genre = String(query.genre).toLowerCase();
    result = result.filter((series) => series.genres.some((item) => item.toLowerCase() === genre));
  }
  const [hydrated, businessMetrics] = await Promise.all([
    hydrateSeriesRuntimeData(event, result),
    getSeriesBusinessMetrics(event),
  ]);
  const sort = String(query.sort || 'Popular');
  hydrated.sort((left, right) => {
    if (sort === 'Newest') return String(right.updatedAt || '').localeCompare(String(left.updatedAt || ''));
    if (sort === 'Most Purchased') return (businessMetrics.get(right.id)?.purchases || 0) - (businessMetrics.get(left.id)?.purchases || 0);
    return (right.views || 0) - (left.views || 0);
  });
  const publicGenreNames = new Set(result.flatMap((series) => series.genres));
  return ok({
    items: hydrated,
    genres: taxonomy.filter((item) => item.type === '分类' && item.enabled && publicGenreNames.has(item.name)).map((item) => item.name),
  });
});
