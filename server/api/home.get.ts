import { homeData } from '~/data/mock';
import { ok } from '~/server/utils/response';
import { hydrateSeriesRuntimeData } from '~/server/utils/series-runtime';

export default defineEventHandler(async (event) => {
  const source = [homeData.featured, ...homeData.sections.flatMap((section) => section.items)];
  const hydrated = await hydrateSeriesRuntimeData(event, [...new Map(source.map((series) => [series.id, series])).values()]);
  const byId = new Map(hydrated.map((series) => [series.id, series]));
  return ok({
    ...homeData,
    featured: byId.get(homeData.featured.id)!,
    sections: homeData.sections.map((section) => ({ ...section, items: section.items.map((series) => byId.get(series.id)!) })),
    generatedAt: new Date().toISOString(),
  });
});
