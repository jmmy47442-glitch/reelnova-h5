import type { HomeSection, Series } from '~/types/content';
import { ok } from '~/server/utils/response';
import { hydrateSeriesRuntimeData } from '~/server/utils/series-runtime';
import { getHomeSections } from '~/server/utils/home-config';
import { getPublicSeries } from '~/server/utils/managed-content';
import { getSeriesBusinessMetrics, sortSeriesByPopularity } from '~/server/utils/content-ranking';

export default defineEventHandler(async (event) => {
  setHeader(event, 'cache-control', 'private, no-store, max-age=0');
  const [configuredSections, published, businessMetrics] = await Promise.all([
    getHomeSections(event), getPublicSeries(event), getSeriesBusinessMetrics(event),
  ]);
  if (!published.length) throw createError({ statusCode: 503, statusMessage: 'No published series are available' });
  // Hydrate the entire catalogue before ranking or limiting it. Counters come
  // exclusively from authorized playback start events stored in D1.
  const series = await hydrateSeriesRuntimeData(event, published);
  const popular = sortSeriesByPopularity(series);
  const newest = [...series].sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')) || a.id.localeCompare(b.id));
  const byId = new Map(series.map((item) => [item.id, item]));
  const sections: HomeSection[] = [{
    id: 'popular', title: 'Popular now', subtitle: 'Most watched on ReelNova', items: popular.slice(0, 12),
  }, {
    id: 'new', title: 'Fresh episodes', subtitle: 'Latest stories and updates', items: newest.slice(0, 12),
  }];
  for (const section of configuredSections) {
    if (!section.enabled || ['popular', 'new'].includes(section.id)) continue;
    let items: Series[];
    if (section.source === '按更新时间自动排序') items = newest;
    else if (section.source === '按收入自动排序') {
      items = [...series].sort((a, b) => (businessMetrics.get(b.id)?.revenueCents || 0) - (businessMetrics.get(a.id)?.revenueCents || 0) || a.id.localeCompare(b.id));
    } else {
      items = section.itemIds.map((id) => byId.get(id)).filter((item): item is Series => Boolean(item));
    }
    if (items.length) sections.push({ id: section.id, title: section.title, subtitle: section.subtitle, items: items.slice(0, section.count) });
  }
  return ok({ featured: popular[0], tabs: ['Popular', 'New', 'Categories'], sections, generatedAt: new Date().toISOString() });
});
