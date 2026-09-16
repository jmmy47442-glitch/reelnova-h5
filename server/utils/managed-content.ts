import type { H3Event } from 'h3';
import type { AdminEpisode, AdminSeries, DomainConfig, PublishStatus, TaxonomyItem } from '~/types/admin';
import type { Series } from '~/types/content';
import { d1All, d1Batch, d1First, d1Run, hasD1Connection, type D1BatchStatement } from './cloudflare-d1';
import { orderEpisodesByIds } from './episode-order';
import { getSystemConfig, saveSystemConfig } from './system-config';

type ManagedSeries = Series & {
  publishStatus: PublishStatus;
  publishAt: string;
  transcodeProgress: number;
  targetRegion: string;
  updatedAt: string;
};

const requireContentDatabase = (event: H3Event) => {
  if (!hasD1Connection(event)) throw createError({ statusCode: 503, statusMessage: 'Cloudflare D1 is required for content management' });
};

type SeriesInput = {
  title: string;
  description: string;
  genres: string[];
  targetRegion: string;
  freeEpisodeCount: number;
  price: number;
};

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

const invalidateNormalizedSeriesCache = () => { normalizedSeriesCache = undefined; };

export const getManagedSeries = async (event: H3Event) => {
  requireContentDatabase(event);
  if (normalizedSeriesCache && normalizedSeriesCache.expiresAt > Date.now()) {
    return cloneSeries(normalizedSeriesCache.value);
  }
  const { listNormalizedSeries } = await import('./normalized-content');
  const value = await listNormalizedSeries(event);
  normalizedSeriesCache = { value: cloneSeries(value), expiresAt: Date.now() + normalizedSeriesCacheTtlMs };
  return cloneSeries(value);
};

export const createManagedSeriesRecord = async (event: H3Event, input: SeriesInput) => {
  requireContentDatabase(event);
  invalidateNormalizedSeriesCache();
  const { createNormalizedSeries } = await import('./normalized-content');
  const created = await createNormalizedSeries(event, input);
  invalidateNormalizedSeriesCache();
  return created;
};

export const updateManagedSeriesRecord = async (event: H3Event, id: string, input: SeriesInput) => {
  requireContentDatabase(event);
  invalidateNormalizedSeriesCache();
  const { updateNormalizedSeries } = await import('./normalized-content');
  const updated = await updateNormalizedSeries(event, id, input);
  invalidateNormalizedSeriesCache();
  return updated;
};

export const updateManagedSeriesCoverRecord = async (event: H3Event, id: string, coverUrl: string) => {
  requireContentDatabase(event);
  const existing = await d1First<{ id: string }>(event,
    'SELECT id FROM series WHERE id = ? AND deleted_at IS NULL', [id]);
  if (!existing) throw createError({ statusCode: 404, statusMessage: 'Series not found' });
  // A series has one editorial artwork in the admin workflow. Keep both
  // placements in sync so the portrait cover also updates Hero backgrounds.
  await d1Run(event, 'UPDATE series SET cover_url = ?, backdrop_url = ?, updated_at = ? WHERE id = ?',
    [coverUrl, coverUrl, new Date().toISOString(), id]);
  invalidateNormalizedSeriesCache();
  return (await getManagedSeries(event)).find((item) => item.id === id)!;
};

export const updateManagedSeriesStatusRecord = async (event: H3Event, id: string, publishStatus: PublishStatus) => {
  requireContentDatabase(event);
  invalidateNormalizedSeriesCache();
  const { updateNormalizedSeriesStatus } = await import('./normalized-content');
  const updated = await updateNormalizedSeriesStatus(event, id, publishStatus);
  invalidateNormalizedSeriesCache();
  return updated;
};

export const duplicateManagedSeriesRecord = async (event: H3Event, id: string) => {
  requireContentDatabase(event);
  invalidateNormalizedSeriesCache();
  const { duplicateNormalizedSeries } = await import('./normalized-content');
  const duplicated = await duplicateNormalizedSeries(event, id);
  invalidateNormalizedSeriesCache();
  return duplicated;
};

export const softDeleteManagedSeriesRecord = async (event: H3Event, id: string) => {
  requireContentDatabase(event);
  invalidateNormalizedSeriesCache();
  const { softDeleteNormalizedSeries } = await import('./normalized-content');
  const deleted = await softDeleteNormalizedSeries(event, id);
  invalidateNormalizedSeriesCache();
  return deleted;
};

export const getManagedEpisodes = async (event: H3Event, seriesId: string, sync = true): Promise<AdminEpisode[]> => {
  requireContentDatabase(event);
  if (!await d1First(event, 'SELECT id FROM series WHERE id = ? AND deleted_at IS NULL', [seriesId])) {
    throw createError({ statusCode: 404, statusMessage: 'Series not found' });
  }
  const { listAdminEpisodes } = await import('./media-pipeline');
  return listAdminEpisodes(event, seriesId, sync);
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
  requireContentDatabase(event);
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
};

export const createManagedEpisodeRecord = async (event: H3Event, seriesId: string, requestedTitle = '') => {
  requireContentDatabase(event);
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
};

export const deleteManagedEpisodeRecord = async (event: H3Event, seriesId: string, episodeId: string) => {
  requireContentDatabase(event);
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
};

export const updateManagedEpisodeAccess = async (event: H3Event, seriesId: string, episodeId: string, isFree: boolean) => {
  requireContentDatabase(event);
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
};

export const getPublicSeries = async (event: H3Event) => {
  const managed = await getManagedSeries(event);
  const published = managed.filter((item) => item.publishStatus === '已上架');
  return published
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

export const getTaxonomyConfig = async (event: H3Event) => {
  requireContentDatabase(event);
  const { listNormalizedTaxonomy } = await import('./normalized-content');
  return listNormalizedTaxonomy(event);
};

export const saveTaxonomyConfig = async (event: H3Event, items: TaxonomyItem[]) => {
  requireContentDatabase(event);
  const { saveNormalizedTaxonomy } = await import('./normalized-content');
  return saveNormalizedTaxonomy(event, items);
};

export const getDomainConfig = (event: H3Event) => getSystemConfig<DomainConfig[]>(event, 'domains', []);

export const saveDomainConfig = async (event: H3Event, items: DomainConfig[]) => {
  await saveSystemConfig(event, 'domains', items);
  return items.map((item) => ({ ...item }));
};

export type { ManagedSeries };
