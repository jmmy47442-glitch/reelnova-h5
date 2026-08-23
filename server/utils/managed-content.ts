import type { H3Event } from 'h3';
import { seriesList } from '~/data/mock';
import type { AdminSeries, DomainConfig, PublishStatus, TaxonomyItem } from '~/types/admin';
import type { Series } from '~/types/content';
import { d1First, d1Run, hasD1Connection } from './cloudflare-d1';

type ManagedSeries = Series & {
  publishStatus: PublishStatus;
  publishAt: string;
  transcodeProgress: number;
  targetRegion: string;
};

interface ConfigRow { payload: string }

const initialSeries = (): ManagedSeries[] => seriesList.map((series) => ({
  ...series,
  genres: [...series.genres],
  cast: [...series.cast],
  episodes: series.episodes.map((episode) => ({ ...episode })),
  publishStatus: '已上架',
  publishAt: '2026-08-11',
  transcodeProgress: 100,
  targetRegion: 'United States',
}));

const initialTaxonomy = (): TaxonomyItem[] => [
  { id: 'tax-01', name: 'Romance', localeName: '爱情', type: '分类', color: '#5d6bff', contentCount: 0, enabled: true, expiresAt: '—' },
  { id: 'tax-02', name: 'Revenge', localeName: '复仇', type: '分类', color: '#d65a67', contentCount: 0, enabled: true, expiresAt: '—' },
  { id: 'tax-03', name: 'Young Adult', localeName: '青春', type: '分类', color: '#2d9d78', contentCount: 0, enabled: true, expiresAt: '—' },
  { id: 'tag-01', name: 'Hot', localeName: '热门', type: '标签', color: '#f05b67', contentCount: 0, enabled: true, expiresAt: '2026-12-31' },
  { id: 'tag-02', name: 'New', localeName: '新上线', type: '标签', color: '#4d78e8', contentCount: 0, enabled: true, expiresAt: '2026-09-30' },
  { id: 'tag-03', name: 'Exclusive', localeName: '独家', type: '标签', color: '#8256c9', contentCount: 0, enabled: true, expiresAt: '—' },
  { id: 'tag-04', name: 'Free', localeName: '免费', type: '标签', color: '#26966f', contentCount: 0, enabled: false, expiresAt: '—' },
];

const initialDomains = (): DomainConfig[] => [];

let memorySeries = initialSeries();
let memoryTaxonomy = initialTaxonomy();
let memoryDomains = initialDomains();

const cloneSeries = (items: ManagedSeries[]) => items.map((item) => ({
  ...item,
  genres: [...item.genres],
  cast: [...item.cast],
  episodes: item.episodes.map((episode) => ({ ...episode })),
}));
const cloneItems = <T extends object>(items: T[]) => items.map((item) => ({ ...item }));

const isMissingConfigTable = (error: unknown) => {
  const value = error as { statusMessage?: unknown; data?: { errors?: Array<{ message?: unknown }> } };
  return `${error instanceof Error ? error.message : ''} ${String(value?.statusMessage || '')} ${value?.data?.errors?.map((item) => String(item.message || '')).join(' ') || ''} ${typeof error === 'object' && error ? JSON.stringify(error) : ''}`.toLowerCase().includes('no such table');
};

const readConfig = async <T>(event: H3Event, id: string, fallback: T): Promise<T> => {
  if (!hasD1Connection(event)) return fallback;
  try {
    const row = await d1First<ConfigRow>(event, 'SELECT payload FROM home_config WHERE id = ?', [id]);
    return row?.payload ? JSON.parse(row.payload) as T : fallback;
  } catch (error) {
    if (isMissingConfigTable(error)) return fallback;
    throw error;
  }
};

const writeConfig = async (event: H3Event, id: string, value: unknown) => {
  if (!hasD1Connection(event)) return;
  try {
    await d1Run(event, `INSERT INTO home_config (id, payload, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`,
    [id, JSON.stringify(value), new Date().toISOString()]);
  } catch (error) {
    // Keep local development usable before migration 0005 is applied.
    if (!isMissingConfigTable(error)) throw error;
  }
};

export const getManagedSeries = async (event: H3Event) => {
  if (hasD1Connection(event)) {
    const { listNormalizedSeries } = await import('./normalized-content');
    return listNormalizedSeries(event);
  }
  const stored = await readConfig<ManagedSeries[]>(event, 'managed-series', memorySeries);
  if (Array.isArray(stored)) memorySeries = cloneSeries(stored);
  return cloneSeries(memorySeries);
};

export const saveManagedSeries = async (event: H3Event, items: ManagedSeries[]) => {
  if (hasD1Connection(event)) throw createError({ statusCode: 500, statusMessage: 'Normalized series must not be written to home_config' });
  memorySeries = cloneSeries(items);
  await writeConfig(event, 'managed-series', memorySeries);
  return cloneSeries(memorySeries);
};

export const createManagedSeriesRecord = async (event: H3Event, input: Parameters<typeof createManagedSeries>[1]) => {
  if (hasD1Connection(event)) {
    const { createNormalizedSeries } = await import('./normalized-content');
    return createNormalizedSeries(event, input);
  }
  const items = await getManagedSeries(event);
  const created = createManagedSeries(items, input);
  items.unshift(created);
  await saveManagedSeries(event, items);
  return created;
};

export const updateManagedSeriesRecord = async (event: H3Event, id: string, input: Parameters<typeof createManagedSeries>[1]) => {
  if (hasD1Connection(event)) {
    const { updateNormalizedSeries } = await import('./normalized-content');
    return updateNormalizedSeries(event, id, input);
  }
  const items = await getManagedSeries(event);
  const item = items.find((entry) => entry.id === id);
  if (!item) throw createError({ statusCode: 404, statusMessage: 'Series not found' });
  Object.assign(item, input, { genres: [...input.genres], publishAt: new Date().toISOString().slice(0, 10) });
  item.episodes = item.episodes.map((episode) => ({ ...episode, isFree: episode.episodeNo <= item.freeEpisodeCount }));
  await saveManagedSeries(event, items);
  return item;
};

export const updateManagedSeriesStatusRecord = async (event: H3Event, id: string, publishStatus: PublishStatus) => {
  if (hasD1Connection(event)) {
    const { updateNormalizedSeriesStatus } = await import('./normalized-content');
    return updateNormalizedSeriesStatus(event, id, publishStatus);
  }
  const items = await getManagedSeries(event);
  const item = items.find((entry) => entry.id === id);
  if (!item) throw createError({ statusCode: 404, statusMessage: 'Series not found' });
  if (publishStatus === '已上架' && (!item.episodeCount || item.transcodeProgress < 100)) {
    throw createError({ statusCode: 409, statusMessage: 'Episodes must finish transcoding before publishing' });
  }
  item.publishStatus = publishStatus;
  item.publishAt = new Date().toISOString().slice(0, 10);
  await saveManagedSeries(event, items);
  return item;
};

export const duplicateManagedSeriesRecord = async (event: H3Event, id: string) => {
  if (hasD1Connection(event)) {
    const { duplicateNormalizedSeries } = await import('./normalized-content');
    return duplicateNormalizedSeries(event, id);
  }
  const items = await getManagedSeries(event);
  const source = items.find((entry) => entry.id === id);
  if (!source) throw createError({ statusCode: 404, statusMessage: 'Series not found' });
  const copy = createManagedSeries(items, {
    title: `${source.title} Copy`, description: source.description, genres: source.genres,
    targetRegion: source.targetRegion, freeEpisodeCount: source.freeEpisodeCount, price: source.price,
  });
  copy.coverUrl = source.coverUrl;
  copy.backdropUrl = source.backdropUrl;
  copy.tagline = source.tagline;
  copy.cast = [...source.cast];
  items.unshift(copy);
  await saveManagedSeries(event, items);
  return copy;
};

export const softDeleteManagedSeriesRecord = async (event: H3Event, id: string) => {
  if (hasD1Connection(event)) {
    const { softDeleteNormalizedSeries } = await import('./normalized-content');
    return softDeleteNormalizedSeries(event, id);
  }
  const items = await getManagedSeries(event);
  const index = items.findIndex((entry) => entry.id === id);
  if (index < 0) throw createError({ statusCode: 404, statusMessage: 'Series not found' });
  const [removed] = items.splice(index, 1);
  await saveManagedSeries(event, items);
  return { id, title: removed!.title, retainedOrderCount: 0 };
};

export const getPublicSeries = async (event: H3Event) => {
  const managed = await getManagedSeries(event);
  const published = managed.filter((item) => item.publishStatus === '已上架');
  const config = useRuntimeConfig(event);
  const isProduction = process.env.NODE_ENV === 'production';
  const mockFallback = !isProduction && String(config.publicMockContentFallback).toLowerCase() === 'true';
  const source = published.length ? published : mockFallback ? initialSeries() : [];
  return source
  .map(({ publishStatus: _publishStatus, publishAt: _publishAt, transcodeProgress: _transcodeProgress, targetRegion: _targetRegion, ...series }) => series);
};

export const toAdminSeries = (item: ManagedSeries): AdminSeries => ({
  id: item.id,
  slug: item.slug,
  title: item.title,
  description: item.description,
  coverUrl: item.coverUrl,
  genres: [...item.genres],
  episodeCount: item.episodeCount,
  freeEpisodeCount: item.freeEpisodeCount,
  price: item.price,
  originalPrice: item.originalPrice,
  publishStatus: item.publishStatus,
  publishAt: item.publishAt,
  transcodeProgress: item.transcodeProgress,
  targetRegion: item.targetRegion,
});

export const createManagedSeries = (items: ManagedSeries[], input: {
  title: string;
  description: string;
  genres: string[];
  targetRegion: string;
  freeEpisodeCount: number;
  price: number;
}): ManagedSeries => {
  const id = `sr-${crypto.randomUUID().slice(0, 8)}`;
  const baseSlug = input.title.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || id;
  let slug = baseSlug;
  let suffix = 2;
  while (items.some((item) => item.slug === slug)) slug = `${baseSlug}-${suffix++}`;
  const today = new Date().toISOString().slice(0, 10);
  return {
    id,
    slug,
    title: input.title,
    tagline: input.title,
    description: input.description,
    coverUrl: '/posters/vows-vengeance.jpg',
    backdropUrl: '/posters/vows-vengeance-wide.jpg',
    badge: 'New' as const,
    genres: [...input.genres],
    views: 0,
    rating: 0,
    episodeCount: 0,
    freeEpisodeCount: input.freeEpisodeCount,
    price: input.price,
    currency: 'USD' as const,
    updatedLabel: 'Draft',
    cast: [],
    episodes: [],
    publishStatus: '草稿' as const,
    publishAt: today,
    transcodeProgress: 0,
    targetRegion: input.targetRegion,
  };
};

export const getTaxonomyConfig = async (event: H3Event) => {
  if (hasD1Connection(event)) {
    const { listNormalizedTaxonomy } = await import('./normalized-content');
    return listNormalizedTaxonomy(event);
  }
  const stored = await readConfig<TaxonomyItem[]>(event, 'taxonomy', memoryTaxonomy);
  if (Array.isArray(stored)) memoryTaxonomy = cloneItems(stored);
  const series = await getManagedSeries(event);
  return cloneItems(memoryTaxonomy).map((item) => ({
    ...item,
    contentCount: series.filter((entry) => item.type === '分类' ? entry.genres.includes(item.name) : entry.badge === item.name).length,
  }));
};

export const saveTaxonomyConfig = async (event: H3Event, items: TaxonomyItem[]) => {
  if (hasD1Connection(event)) {
    const { saveNormalizedTaxonomy } = await import('./normalized-content');
    return saveNormalizedTaxonomy(event, items);
  }
  memoryTaxonomy = cloneItems(items).map((item) => ({ ...item, contentCount: 0 }));
  await writeConfig(event, 'taxonomy', memoryTaxonomy);
  return getTaxonomyConfig(event);
};

export const getDomainConfig = async (event: H3Event) => {
  const stored = await readConfig<DomainConfig[]>(event, 'domains', memoryDomains);
  if (Array.isArray(stored)) memoryDomains = cloneItems(stored);
  return cloneItems(memoryDomains);
};

export const saveDomainConfig = async (event: H3Event, items: DomainConfig[]) => {
  memoryDomains = cloneItems(items);
  await writeConfig(event, 'domains', memoryDomains);
  return cloneItems(memoryDomains);
};

export type { ManagedSeries };
