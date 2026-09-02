import { homeData } from '~/data/mock';
import { ok } from '~/server/utils/response';
import { hydrateSeriesRuntimeData } from '~/server/utils/series-runtime';
import { getHomeSections } from '~/server/utils/home-config';
import { getPublicSeries } from '~/server/utils/managed-content';
import { getSeriesBusinessMetrics } from '~/server/utils/content-ranking';

const sortConfiguredItems = (section: Awaited<ReturnType<typeof getHomeSections>>[number], items: typeof homeData.sections[number]['items'], metrics: Awaited<ReturnType<typeof getSeriesBusinessMetrics>>) => {
  if (section.source === '按更新时间自动排序') {
    return [...items].sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')));
  }
  if (section.source === '按收入自动排序') {
    return [...items].sort((left, right) => {
      const revenueDelta = (metrics.get(right.id)?.revenueCents || 0) - (metrics.get(left.id)?.revenueCents || 0);
      return revenueDelta || String(right.updatedAt || '').localeCompare(String(left.updatedAt || ''));
    });
  }
  return items;
};

export default defineEventHandler(async (event) => {
  const configuredSections = await getHomeSections(event);
  const seriesList = await getPublicSeries(event);
  const businessMetrics = await getSeriesBusinessMetrics(event);
  if (!seriesList.length) throw createError({ statusCode: 503, statusMessage: 'No published series are available' });
  const seriesById = new Map(seriesList.map((series) => [series.id, series]));
  const configured = configuredSections.filter((section) => section.enabled).map((section) => ({
    id: section.id,
    title: section.title,
    subtitle: section.subtitle,
    items: sortConfiguredItems(section,
      section.source === '手动推荐 + 热度排序'
        ? section.itemIds.map((id) => seriesById.get(id)).filter((series): series is typeof seriesList[number] => Boolean(series))
        : seriesList,
      businessMetrics).slice(0, section.count),
  })).filter((section) => section.items.length);
  const configuredItemIds = new Set(configured.flatMap((section) => section.items.map((series) => series.id)));
  const latestUnplaced = configured.length ? seriesList.filter((series) => !configuredItemIds.has(series.id)).slice(0, 12) : [];
  const featured = seriesById.get(homeData.featured.id) || seriesList[0];
  const sections = configured.length ? [
    ...configured,
    ...(latestUnplaced.length ? [{
      id: 'latest-releases',
      title: 'Latest releases',
      subtitle: 'Newly published and ready to watch',
      items: latestUnplaced,
    }] : []),
  ] : [{
    id: 'popular',
    title: 'Popular now',
    subtitle: 'Available to watch now',
    items: seriesList.slice(0, 12),
  }];
  const source = [featured, ...sections.flatMap((section) => section.items)];
  const hydrated = await hydrateSeriesRuntimeData(event, [...new Map(source.map((series) => [series.id, series])).values()]);
  const byId = new Map(hydrated.map((series) => [series.id, series]));
  return ok({
    ...homeData,
    featured: byId.get(featured.id)!,
    sections: sections.map((section) => ({ ...section, items: section.items.map((series) => byId.get(series.id)!) })),
    generatedAt: new Date().toISOString(),
  });
});
