import type { H3Event } from 'h3';
import { seriesList } from '~/data/mock';
import type { AdminEpisode, AdminSeries, DomainConfig, PublishStatus, TaxonomyItem } from '~/types/admin';
import type { Series } from '~/types/content';
import { d1All, d1Batch, d1First, d1Run, hasD1Connection, type D1BatchStatement } from './cloudflare-d1';
import { orderEpisodesByIds } from './episode-order';

type ManagedSeries = Series & {
  publishStatus: PublishStatus;
  publishAt: string;
  transcodeProgress: number;
  targetRegion: string;
  updatedAt: string;
};

interface ConfigRow { payload: string }

const initialSeries = (): ManagedSeries[] => seriesList.map((series, index) => ({
  ...series,
  genres: [...series.genres],
  cast: [...series.cast],
  episodes: series.episodes.map((episode) => ({ ...episode })),
  publishStatus: '已上架',
  publishAt: '2026-08-11',
  transcodeProgress: 100,
  targetRegion: 'United States',
  updatedAt: `2026-08-${String(11 - (index % 7)).padStart(2, '0')}T00:00:00.000Z`,
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
const normalizedSeriesCacheTtlMs = 5_000;
let normalizedSeriesCache: { expiresAt: number; value: ManagedSeries[] } | undefined;

const cloneSeries = (items: ManagedSeries[]) => items.map((item) => ({
  ...item,
  genres: [...item.genres],
  cast: [...item.cast],
  episodes: item.episodes.map((episode) => ({ ...episode })),
  // Keep the legacy series-level count accurate once episodes exist.
  freeEpisodeCount: item.episodes.length ? item.episodes.filter((episode) => episode.isFree).length : item.freeEpisodeCount,
}));
const cloneItems = <T extends object>(items: T[]) => items.map((item) => ({ ...item }));
const invalidateNormalizedSeriesCache = () => { normalizedSeriesCache = undefined; };

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
    if (normalizedSeriesCache && normalizedSeriesCache.expiresAt > Date.now()) {
      return cloneSeries(normalizedSeriesCache.value);
    }
    const { listNormalizedSeries } = await import('./normalized-content');
    const value = await listNormalizedSeries(event);
    normalizedSeriesCache = { value: cloneSeries(value), expiresAt: Date.now() + normalizedSeriesCacheTtlMs };
    return cloneSeries(value);
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
    invalidateNormalizedSeriesCache();
    const { createNormalizedSeries } = await import('./normalized-content');
    const created = await createNormalizedSeries(event, input);
    invalidateNormalizedSeriesCache();
    return created;
  }
  const items = await getManagedSeries(event);
  const created = createManagedSeries(items, input);
  items.unshift(created);
  await saveManagedSeries(event, items);
  return created;
};

export const updateManagedSeriesRecord = async (event: H3Event, id: string, input: Parameters<typeof createManagedSeries>[1]) => {
  if (hasD1Connection(event)) {
    invalidateNormalizedSeriesCache();
    const { updateNormalizedSeries } = await import('./normalized-content');
    const updated = await updateNormalizedSeries(event, id, input);
    invalidateNormalizedSeriesCache();
    return updated;
  }
  const items = await getManagedSeries(event);
  const item = items.find((entry) => entry.id === id);
  if (!item) throw createError({ statusCode: 404, statusMessage: 'Series not found' });
  const now = new Date().toISOString();
  Object.assign(item, input, { genres: [...input.genres], publishAt: now.slice(0, 10), updatedAt: now });
  if (item.episodes.length) item.freeEpisodeCount = item.episodes.filter((episode) => episode.isFree).length;
  await saveManagedSeries(event, items);
  return item;
};

export const updateManagedSeriesCoverRecord = async (event: H3Event, id: string, coverUrl: string) => {
  if (hasD1Connection(event)) {
    const existing = await d1First<{ id: string }>(event,
      'SELECT id FROM series WHERE id = ? AND deleted_at IS NULL', [id]);
    if (!existing) throw createError({ statusCode: 404, statusMessage: 'Series not found' });
    await d1Run(event, 'UPDATE series SET cover_url = ?, updated_at = ? WHERE id = ?',
      [coverUrl, new Date().toISOString(), id]);
    invalidateNormalizedSeriesCache();
    return (await getManagedSeries(event)).find((item) => item.id === id)!;
  }
  const items = await getManagedSeries(event);
  const item = items.find((entry) => entry.id === id);
  if (!item) throw createError({ statusCode: 404, statusMessage: 'Series not found' });
  item.coverUrl = coverUrl;
  item.updatedAt = new Date().toISOString();
  item.publishAt = item.updatedAt.slice(0, 10);
  await saveManagedSeries(event, items);
  return item;
};

export const updateManagedSeriesStatusRecord = async (event: H3Event, id: string, publishStatus: PublishStatus) => {
  if (hasD1Connection(event)) {
    invalidateNormalizedSeriesCache();
    const { updateNormalizedSeriesStatus } = await import('./normalized-content');
    const updated = await updateNormalizedSeriesStatus(event, id, publishStatus);
    invalidateNormalizedSeriesCache();
    return updated;
  }
  const items = await getManagedSeries(event);
  const item = items.find((entry) => entry.id === id);
  if (!item) throw createError({ statusCode: 404, statusMessage: 'Series not found' });
  if (publishStatus === '已上架' && (!item.episodeCount || item.transcodeProgress < 100)) {
    throw createError({ statusCode: 409, statusMessage: 'Episodes must finish transcoding before publishing' });
  }
  item.publishStatus = publishStatus;
  const now = new Date().toISOString();
  item.publishAt = now.slice(0, 10);
  item.updatedAt = now;
  await saveManagedSeries(event, items);
  return item;
};

export const duplicateManagedSeriesRecord = async (event: H3Event, id: string) => {
  if (hasD1Connection(event)) {
    invalidateNormalizedSeriesCache();
    const { duplicateNormalizedSeries } = await import('./normalized-content');
    const duplicated = await duplicateNormalizedSeries(event, id);
    invalidateNormalizedSeriesCache();
    return duplicated;
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
    invalidateNormalizedSeriesCache();
    const { softDeleteNormalizedSeries } = await import('./normalized-content');
    const deleted = await softDeleteNormalizedSeries(event, id);
    invalidateNormalizedSeriesCache();
    return deleted;
  }
  const items = await getManagedSeries(event);
  const index = items.findIndex((entry) => entry.id === id);
  if (index < 0) throw createError({ statusCode: 404, statusMessage: 'Series not found' });
  const [removed] = items.splice(index, 1);
  await saveManagedSeries(event, items);
  return { id, title: removed!.title, retainedOrderCount: 0 };
};

const memoryEpisodeToAdmin = (episode: ManagedSeries['episodes'][number]): AdminEpisode => {
  const [minutes = '0', seconds = '0'] = episode.duration.split(':');
  return {
    id: episode.id,
    episodeNo: episode.episodeNo,
    title: episode.title,
    durationSeconds: Number(minutes) * 60 + Number(seconds),
    isFree: episode.isFree,
    videoStatus: episode.mediaStatus || 'waiting_upload',
    transcodeProgress: episode.transcodeProgress || 0,
    thumbnailUrl: '',
    mediaAssetId: null,
    uploadId: null,
    sourceFileName: null,
    sourceSizeBytes: null,
    errorMessage: null,
    previewUrl: null,
  };
};

export const getManagedEpisodes = async (event: H3Event, seriesId: string, sync = true): Promise<AdminEpisode[]> => {
  if (hasD1Connection(event)) {
    if (!await d1First(event, 'SELECT id FROM series WHERE id = ? AND deleted_at IS NULL', [seriesId])) {
      throw createError({ statusCode: 404, statusMessage: 'Series not found' });
    }
    const { listAdminEpisodes } = await import('./media-pipeline');
    return listAdminEpisodes(event, seriesId, sync);
  }
  const series = (await getManagedSeries(event)).find((item) => item.id === seriesId);
  if (!series) throw createError({ statusCode: 404, statusMessage: 'Series not found' });
  return series.episodes.map(memoryEpisodeToAdmin).sort((left, right) => left.episodeNo - right.episodeNo);
};

const episodeNumberCase = (episodeIds: string[]) => ({
  sql: `CASE id ${episodeIds.map(() => 'WHEN ? THEN ?').join(' ')} ELSE episode_no END`,
  params: episodeIds.flatMap((id, index) => [id, index + 1]),
});

const moveDeletedEpisodesPastActiveRange = (seriesId: string, deletedIds: string[], base: number, now: string): D1BatchStatement[] => {
  if (!deletedIds.length) return [];
  const deletedCase = {
    sql: `CASE id ${deletedIds.map(() => 'WHEN ? THEN ?').join(' ')} ELSE episode_no END`,
    params: deletedIds.flatMap((id, index) => [id, base + index + 1]),
  };
  return [{
    sql: `UPDATE episodes SET episode_no = (${deletedCase.sql}), updated_at = ?
      WHERE series_id = ? AND deleted_at IS NOT NULL`,
    params: [...deletedCase.params, now, seriesId],
  }];
};

const resequenceEpisodeStatements = (seriesId: string, episodeIds: string[], tempBase: number, now: string): D1BatchStatement[] => {
  if (!episodeIds.length) return [];
  const numberCase = episodeNumberCase(episodeIds);
  return [
    {
      sql: `UPDATE episodes SET title = CASE WHEN title = 'Episode ' || episode_no THEN 'Episode ' || (${numberCase.sql}) ELSE title END,
        updated_at = ? WHERE series_id = ? AND deleted_at IS NULL`,
      params: [...numberCase.params, now, seriesId],
    },
    {
      sql: `UPDATE episodes SET episode_no = ? + (${numberCase.sql}), updated_at = ?
        WHERE series_id = ? AND deleted_at IS NULL`,
      params: [tempBase, ...numberCase.params, now, seriesId],
    },
    {
      sql: `UPDATE episodes SET episode_no = (${numberCase.sql}), updated_at = ?
        WHERE series_id = ? AND deleted_at IS NULL`,
      params: [...numberCase.params, now, seriesId],
    },
  ];
};

export const reorderManagedEpisodeRecords = async (event: H3Event, seriesId: string, episodeIds: string[]) => {
  if (hasD1Connection(event)) {
    invalidateNormalizedSeriesCache();
    const series = await d1First<{ id: string; title: string }>(event,
      'SELECT id, title FROM series WHERE id = ? AND deleted_at IS NULL', [seriesId]);
    if (!series) throw createError({ statusCode: 404, statusMessage: 'Series not found' });
    const current = await d1All<{ id: string; episode_no: number; title: string; is_free: number }>(event,
      'SELECT id, episode_no, title, is_free FROM episodes WHERE series_id = ? AND deleted_at IS NULL ORDER BY episode_no', [seriesId]);
    try {
      orderEpisodesByIds(current.map((episode) => ({
        id: episode.id, episodeNo: episode.episode_no, title: episode.title, isFree: Boolean(episode.is_free),
      })), episodeIds);
    } catch (error) {
      throw createError({ statusCode: 400, statusMessage: error instanceof Error ? error.message : 'Invalid episode order' });
    }
    const activeUpload = await d1First<{ id: string }>(event, `SELECT u.id FROM media_upload_sessions u
      JOIN media_assets a ON a.id = u.media_asset_id JOIN episodes e ON e.id = a.episode_id
      WHERE e.series_id = ? AND e.deleted_at IS NULL AND u.status IN ('created', 'uploading') LIMIT 1`, [seriesId]);
    if (activeUpload) throw createError({ statusCode: 409, statusMessage: 'Finish or cancel active uploads before reordering episodes' });
    const maximum = await d1First<{ episode_no: number }>(event,
      'SELECT COALESCE(MAX(episode_no), 0) AS episode_no FROM episodes WHERE series_id = ?', [seriesId]);
    const deleted = await d1All<{ id: string }>(event,
      'SELECT id FROM episodes WHERE series_id = ? AND deleted_at IS NOT NULL ORDER BY episode_no, id', [seriesId]);
    const base = Math.max(10_000, Number(maximum?.episode_no || 0));
    const now = new Date().toISOString();
    await d1Batch(event, [
      ...moveDeletedEpisodesPastActiveRange(seriesId, deleted.map((item) => item.id), base, now),
      ...resequenceEpisodeStatements(seriesId, episodeIds, base + deleted.length + episodeIds.length + 1, now),
      {
        sql: `UPDATE series SET status = CASE WHEN status = 'rights_frozen' THEN status ELSE 'draft' END, updated_at = ? WHERE id = ?`,
        params: [now, seriesId],
      },
    ]);
    invalidateNormalizedSeriesCache();
    return { items: await getManagedEpisodes(event, seriesId, false), seriesTitle: series.title };
  }

  const items = await getManagedSeries(event);
  const series = items.find((item) => item.id === seriesId);
  if (!series) throw createError({ statusCode: 404, statusMessage: 'Series not found' });
  try {
    series.episodes = orderEpisodesByIds(series.episodes, episodeIds);
  } catch (error) {
    throw createError({ statusCode: 400, statusMessage: error instanceof Error ? error.message : 'Invalid episode order' });
  }
  if (series.publishStatus !== '版权冻结') series.publishStatus = '草稿';
  series.publishAt = new Date().toISOString().slice(0, 10);
  await saveManagedSeries(event, items);
  return { items: series.episodes.map(memoryEpisodeToAdmin), seriesTitle: series.title };
};

export const createManagedEpisodeRecord = async (event: H3Event, seriesId: string, requestedTitle = '') => {
  if (hasD1Connection(event)) {
    invalidateNormalizedSeriesCache();
    const series = await d1First<{ id: string; title: string; free_episode_count: number }>(event,
      'SELECT id, title, free_episode_count FROM series WHERE id = ? AND deleted_at IS NULL', [seriesId]);
    if (!series) throw createError({ statusCode: 404, statusMessage: 'Series not found' });
    const lastEpisode = await d1First<{ episode_no: number }>(event,
      'SELECT MAX(episode_no) AS episode_no FROM episodes WHERE series_id = ? AND deleted_at IS NULL', [seriesId]);
    const episodeNo = Number(lastEpisode?.episode_no || 0) + 1;
    if (episodeNo > 10_000) throw createError({ statusCode: 409, statusMessage: 'Episode limit reached' });
    const title = requestedTitle || `Episode ${episodeNo}`;
    const id = `ep_${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    await d1Run(event, `INSERT INTO episodes
      (id, series_id, episode_no, title, duration_seconds, is_free, video_status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 0, ?, 'waiting_upload', ?, ?)`,
    [id, seriesId, episodeNo, title, episodeNo <= series.free_episode_count ? 1 : 0, now, now]);
    await d1Run(event, `UPDATE series SET status = CASE WHEN status = 'rights_frozen' THEN status ELSE 'draft' END,
      updated_at = ? WHERE id = ?`, [now, seriesId]);
    invalidateNormalizedSeriesCache();
    const episode = (await getManagedEpisodes(event, seriesId, false)).find((item) => item.id === id)!;
    return { episode, seriesTitle: series.title };
  }

  const items = await getManagedSeries(event);
  const series = items.find((item) => item.id === seriesId);
  if (!series) throw createError({ statusCode: 404, statusMessage: 'Series not found' });
  const episodeNo = Math.max(0, ...series.episodes.map((episode) => episode.episodeNo)) + 1;
  if (episodeNo > 10_000) throw createError({ statusCode: 409, statusMessage: 'Episode limit reached' });
  const title = requestedTitle || `Episode ${episodeNo}`;
  const episode = {
    id: `ep_${crypto.randomUUID()}`,
    episodeNo,
    title,
    duration: '0:00',
    isFree: episodeNo <= series.freeEpisodeCount,
    isUnlocked: episodeNo <= series.freeEpisodeCount,
    mediaStatus: 'waiting_upload' as const,
    transcodeProgress: 0,
  };
  series.episodes.push(episode);
  series.episodeCount = series.episodes.length;
  series.updatedLabel = `${series.episodeCount} EP`;
  if (series.publishStatus !== '版权冻结') series.publishStatus = '草稿';
  series.publishAt = new Date().toISOString().slice(0, 10);
  await saveManagedSeries(event, items);
  return { episode: memoryEpisodeToAdmin(episode), seriesTitle: series.title };
};

export const deleteManagedEpisodeRecord = async (event: H3Event, seriesId: string, episodeId: string) => {
  if (hasD1Connection(event)) {
    invalidateNormalizedSeriesCache();
    const [
      episodeResult,
      activeUploadResult,
      remainingResult,
      maximumResult,
      previouslyDeletedResult,
    ] = await d1Batch(event, [
      {
        sql: `SELECT e.id, e.episode_no, e.title, s.title AS series_title
          FROM episodes e JOIN series s ON s.id = e.series_id
          WHERE e.id = ? AND e.series_id = ? AND e.deleted_at IS NULL AND s.deleted_at IS NULL`,
        params: [episodeId, seriesId],
      },
      {
        sql: `SELECT u.id FROM media_upload_sessions u
          JOIN media_assets a ON a.id = u.media_asset_id
          WHERE a.episode_id = ? AND u.status IN ('created', 'uploading') LIMIT 1`,
        params: [episodeId],
      },
      {
        sql: 'SELECT id FROM episodes WHERE series_id = ? AND deleted_at IS NULL AND id <> ? ORDER BY episode_no',
        params: [seriesId, episodeId],
      },
      {
        sql: 'SELECT COALESCE(MAX(episode_no), 0) AS episode_no FROM episodes WHERE series_id = ?',
        params: [seriesId],
      },
      {
        sql: 'SELECT id FROM episodes WHERE series_id = ? AND deleted_at IS NOT NULL ORDER BY episode_no, id',
        params: [seriesId],
      },
    ]);
    const episode = episodeResult?.results?.[0] as { id: string; episode_no: number; title: string; series_title: string } | undefined;
    if (!episode) throw createError({ statusCode: 404, statusMessage: 'Episode not found' });
    const activeUpload = activeUploadResult?.results?.[0] as { id: string } | undefined;
    if (activeUpload) {
      throw createError({ statusCode: 409, statusMessage: 'Cancel the active upload before deleting this episode' });
    }
    const remaining = (remainingResult?.results || []) as Array<{ id: string }>;
    const maximum = maximumResult?.results?.[0] as { episode_no: number } | undefined;
    const previouslyDeleted = (previouslyDeletedResult?.results || []) as Array<{ id: string }>;
    const remainingIds = remaining.map((item) => item.id);
    const base = Math.max(10_000, Number(maximum?.episode_no || 0));
    const tombstoneNo = base + previouslyDeleted.length + 1;
    const now = new Date().toISOString();
    await d1Batch(event, [
      {
        sql: `UPDATE transcode_jobs SET status = 'cancelled', updated_at = ?, completed_at = COALESCE(completed_at, ?)
          WHERE media_asset_id IN (SELECT id FROM media_assets WHERE episode_id = ?) AND status IN ('queued', 'processing')`,
        params: [now, now, episodeId],
      },
      {
        sql: `UPDATE media_assets SET status = 'superseded', deleted_at = COALESCE(deleted_at, ?), updated_at = ?
          WHERE episode_id = ? AND deleted_at IS NULL`,
        params: [now, now, episodeId],
      },
      ...moveDeletedEpisodesPastActiveRange(seriesId, previouslyDeleted.map((item) => item.id), base, now),
      {
        sql: 'UPDATE episodes SET episode_no = ?, deleted_at = ?, updated_at = ? WHERE id = ?',
        params: [tombstoneNo, now, now, episodeId],
      },
      ...resequenceEpisodeStatements(seriesId, remainingIds, tombstoneNo + remainingIds.length + 1, now),
      {
        sql: `UPDATE series SET free_episode_count = (SELECT COUNT(*) FROM episodes WHERE series_id = ? AND deleted_at IS NULL AND is_free = 1),
          status = CASE WHEN status = 'rights_frozen' THEN status ELSE 'draft' END, updated_at = ? WHERE id = ?`,
        params: [seriesId, now, seriesId],
      },
    ]);
    invalidateNormalizedSeriesCache();
    return { id: episode.id, episodeNo: episode.episode_no, title: episode.title, seriesTitle: episode.series_title, items: await getManagedEpisodes(event, seriesId, false) };
  }

  const items = await getManagedSeries(event);
  const series = items.find((item) => item.id === seriesId);
  if (!series) throw createError({ statusCode: 404, statusMessage: 'Series not found' });
  const index = series.episodes.findIndex((episode) => episode.id === episodeId);
  if (index < 0) throw createError({ statusCode: 404, statusMessage: 'Episode not found' });
  const [episode] = series.episodes.splice(index, 1);
  series.episodes = orderEpisodesByIds(
    series.episodes,
    series.episodes.sort((left, right) => left.episodeNo - right.episodeNo).map((item) => item.id),
  );
  series.episodeCount = series.episodes.length;
  series.freeEpisodeCount = series.episodes.filter((item) => item.isFree).length;
  series.updatedLabel = `${series.episodeCount} EP`;
  if (series.publishStatus !== '版权冻结') series.publishStatus = '草稿';
  series.publishAt = new Date().toISOString().slice(0, 10);
  await saveManagedSeries(event, items);
  return { id: episode!.id, episodeNo: episode!.episodeNo, title: episode!.title, seriesTitle: series.title, items: series.episodes.map(memoryEpisodeToAdmin) };
};

export const updateManagedEpisodeAccess = async (event: H3Event, seriesId: string, episodeId: string, isFree: boolean) => {
  if (hasD1Connection(event)) {
    invalidateNormalizedSeriesCache();
    const episode = await d1First<{ id: string; title: string; episode_no: number; series_title: string }>(event,
      `SELECT e.id, e.title, e.episode_no, s.title AS series_title
       FROM episodes e JOIN series s ON s.id = e.series_id
       WHERE e.id = ? AND e.series_id = ? AND e.deleted_at IS NULL AND s.deleted_at IS NULL`, [episodeId, seriesId]);
    if (!episode) throw createError({ statusCode: 404, statusMessage: 'Episode not found' });
    const now = new Date().toISOString();
    await d1Batch(event, [
      { sql: 'UPDATE episodes SET is_free = ?, updated_at = ? WHERE id = ?', params: [isFree ? 1 : 0, now, episodeId] },
      { sql: `UPDATE series SET free_episode_count = (SELECT COUNT(*) FROM episodes WHERE series_id = ? AND deleted_at IS NULL AND is_free = 1),
        updated_at = ? WHERE id = ?`, params: [seriesId, now, seriesId] },
    ]);
    const updated = (await getManagedEpisodes(event, seriesId, false)).find((item) => item.id === episodeId);
    if (!updated) throw createError({ statusCode: 404, statusMessage: 'Episode not found' });
    invalidateNormalizedSeriesCache();
    return { episode: updated, seriesTitle: episode.series_title };
  }
  const items = await getManagedSeries(event);
  const series = items.find((item) => item.id === seriesId);
  const episode = series?.episodes.find((item) => item.id === episodeId);
  if (!series || !episode) throw createError({ statusCode: 404, statusMessage: 'Episode not found' });
  episode.isFree = isFree;
  episode.isUnlocked = isFree;
  series.freeEpisodeCount = series.episodes.filter((item) => item.isFree).length;
  const now = new Date().toISOString();
  series.updatedAt = now;
  await saveManagedSeries(event, items);
  return { episode: memoryEpisodeToAdmin(episode), seriesTitle: series.title };
};

export const getPublicSeries = async (event: H3Event) => {
  const managed = await getManagedSeries(event);
  const published = managed.filter((item) => item.publishStatus === '已上架');
  const config = useRuntimeConfig(event);
  const isProduction = process.env.NODE_ENV === 'production';
  const mockFallback = !isProduction && String(config.publicMockContentFallback).toLowerCase() === 'true';
  const source = published.length ? published : mockFallback ? initialSeries() : [];
  return source
  .map(({ publishStatus: _publishStatus, publishAt, transcodeProgress: _transcodeProgress, targetRegion: _targetRegion, ...series }) => ({
    ...series,
    updatedAt: series.updatedAt || publishAt,
  }));
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
    updatedAt: `${today}T00:00:00.000Z`,
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
