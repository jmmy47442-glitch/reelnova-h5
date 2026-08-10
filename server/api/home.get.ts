import { homeData, seriesList } from '~/data/mock';
import { ok } from '~/server/utils/response';
import { hydrateSeriesRuntimeData } from '~/server/utils/series-runtime';
import { getHomeSections } from '~/server/utils/home-config';

export default defineEventHandler(async (event) => {
  const configuredSections = await getHomeSections(event);
  const seriesById = new Map(seriesList.map((series) => [series.id, series]));
  const sections = configuredSections.filter((section) => section.enabled).map((section) => ({
    id: section.id,
    title: section.title,
    subtitle: section.subtitle,
    items: section.itemIds.slice(0, section.count).map((id) => seriesById.get(id)).filter((series): series is typeof seriesList[number] => Boolean(series)),
  })).filter((section) => section.items.length);
  const source = [homeData.featured, ...sections.flatMap((section) => section.items)];
  const hydrated = await hydrateSeriesRuntimeData(event, [...new Map(source.map((series) => [series.id, series])).values()]);
  const byId = new Map(hydrated.map((series) => [series.id, series]));
  return ok({
    ...homeData,
    featured: byId.get(homeData.featured.id)!,
    sections: sections.map((section) => ({ ...section, items: section.items.map((series) => byId.get(series.id)!) })),
    generatedAt: new Date().toISOString(),
  });
});
