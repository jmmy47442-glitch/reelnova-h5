import type { H3Event } from 'h3';
import type { SeriesMutationInput } from './admin-content-input';
import type { ManagedSeries } from './managed-content';
import type { PublishStatus, TaxonomyItem } from '~/types/admin';
import { d1All, d1First, d1Run } from './cloudflare-d1';

interface SeriesRow {
  id: string;
  slug: string;
  title: string;
  tagline: string;
  description: string;
  cover_url: string;
  backdrop_url: string;
  badge: string | null;
  target_region: string;
  cast_json: string;
  free_episode_count: number;
  price_cents: number;
  original_price_cents: number | null;
  currency: 'USD';
  status: string;
  published_at: string | null;
  scheduled_at: string | null;
  updated_at: string;
}

interface EpisodeRow {
  id: string;
  series_id: string;
  episode_no: number;
  title: string;
  duration_seconds: number;
  is_free: number;
  video_status: string;
  progress: number | null;
}

interface AssociationRow { series_id: string; name: string }

interface TaxonomyRow {
  id: string;
  name: string;
  locale_name: string;
  color: string;
  enabled: number;
  expires_at: string | null;
  content_count: number;
  type: '分类' | '标签';
}

const statusToPublic: Record<string, PublishStatus> = {
  published: '已上架', processing: '处理中', draft: '草稿', scheduled: '待发布',
  unpublished: '已下架', rights_frozen: '版权冻结',
};

const statusToDatabase: Record<PublishStatus, string> = Object.fromEntries(
  Object.entries(statusToPublic).map(([key, value]) => [value, key]),
) as Record<PublishStatus, string>;

const safeJsonArray = (value: string) => {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
};

const formatDuration = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
const defaultCoverUrl = '/posters/vows-vengeance.jpg';
const defaultBackdropUrl = '/posters/vows-vengeance-wide.jpg';

export const listNormalizedSeries = async (event: H3Event): Promise<ManagedSeries[]> => {
  const [rows, episodeRows, categoryRows, tagRows] = await Promise.all([
    d1All<SeriesRow>(event, 'SELECT * FROM series WHERE deleted_at IS NULL ORDER BY updated_at DESC'),
    d1All<EpisodeRow>(event, `SELECT e.id, e.series_id, e.episode_no, e.title, e.duration_seconds, e.is_free, e.video_status,
      (SELECT progress FROM transcode_jobs j JOIN media_assets a ON a.id = j.media_asset_id
       WHERE a.episode_id = e.id ORDER BY j.created_at DESC LIMIT 1) AS progress
      FROM episodes e WHERE e.deleted_at IS NULL ORDER BY e.series_id, e.episode_no`),
    d1All<AssociationRow>(event, `SELECT sc.series_id, c.name FROM series_categories sc
      JOIN categories c ON c.id = sc.category_id WHERE c.deleted_at IS NULL ORDER BY sc.sort_order`),
    d1All<AssociationRow>(event, `SELECT st.series_id, t.name FROM series_tags st
      JOIN tags t ON t.id = st.tag_id WHERE t.deleted_at IS NULL ORDER BY st.sort_order`),
  ]);

  const episodesBySeries = new Map<string, EpisodeRow[]>();
  const categoriesBySeries = new Map<string, string[]>();
  const tagsBySeries = new Map<string, string[]>();
  episodeRows.forEach((row) => episodesBySeries.set(row.series_id, [...(episodesBySeries.get(row.series_id) || []), row]));
  categoryRows.forEach((row) => categoriesBySeries.set(row.series_id, [...(categoriesBySeries.get(row.series_id) || []), row.name]));
  tagRows.forEach((row) => tagsBySeries.set(row.series_id, [...(tagsBySeries.get(row.series_id) || []), row.name]));

  return rows.map((row) => {
    const episodes = episodesBySeries.get(row.id) || [];
    const hasReadyEpisode = episodes.some((episode) => episode.video_status === 'ready');
    const progress = episodes.length
      ? Math.round(episodes.reduce((sum, episode) => sum + (episode.video_status === 'ready' ? 100 : Number(episode.progress || 0)), 0) / episodes.length)
      : 0;
    return {
      id: row.id,
      slug: row.slug,
      title: row.title,
      tagline: row.tagline || row.title,
      description: row.description,
      coverUrl: hasReadyEpisode && (!row.cover_url || row.cover_url === defaultCoverUrl)
        ? `/api/media/poster/${encodeURIComponent(row.id)}?variant=cover`
        : row.cover_url,
      backdropUrl: hasReadyEpisode && (!row.backdrop_url || row.backdrop_url === defaultBackdropUrl)
        ? `/api/media/poster/${encodeURIComponent(row.id)}?variant=backdrop`
        : row.backdrop_url,
      badge: (tagsBySeries.get(row.id)?.[0] || row.badge || 'New') as ManagedSeries['badge'],
      genres: categoriesBySeries.get(row.id) || [],
      views: 0,
      rating: 0,
      episodeCount: episodes.length,
      freeEpisodeCount: row.free_episode_count,
      price: row.price_cents / 100,
      originalPrice: row.original_price_cents == null ? undefined : row.original_price_cents / 100,
      currency: row.currency,
      updatedLabel: `${episodes.length} EP`,
      cast: safeJsonArray(row.cast_json),
      episodes: episodes.map((episode) => ({
        id: episode.id,
        episodeNo: episode.episode_no,
        title: episode.title,
        duration: formatDuration(episode.duration_seconds),
        isFree: Boolean(episode.is_free),
        isUnlocked: Boolean(episode.is_free),
        mediaStatus: episode.video_status as ManagedSeries['episodes'][number]['mediaStatus'],
        transcodeProgress: episode.video_status === 'ready' ? 100 : Number(episode.progress || 0),
      })),
      publishStatus: statusToPublic[row.status] || '草稿',
      publishAt: (row.published_at || row.scheduled_at || row.updated_at).slice(0, 10),
      transcodeProgress: progress,
      targetRegion: row.target_region,
    };
  });
};

const makeSlug = async (event: H3Event, title: string, excludedId = '') => {
  const base = title.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || `series-${crypto.randomUUID().slice(0, 8)}`;
  let slug = base;
  let suffix = 2;
  while (await d1First<{ id: string }>(event, 'SELECT id FROM series WHERE slug = ? COLLATE NOCASE AND id <> ? LIMIT 1', [slug, excludedId])) {
    slug = `${base}-${suffix++}`;
  }
  return slug;
};

const categoryIdsForNames = async (event: H3Event, names: string[]) => {
  const now = new Date().toISOString();
  const ids: string[] = [];
  for (const name of names) {
    let row = await d1First<{ id: string }>(event, 'SELECT id FROM categories WHERE name = ? COLLATE NOCASE', [name]);
    if (!row) {
      const id = `cat_${crypto.randomUUID()}`;
      await d1Run(event, `INSERT INTO categories
        (id, name, locale_name, color, sort_order, enabled, created_at, updated_at)
        VALUES (?, ?, ?, '#5d6bff', 100, 1, ?, ?)`, [id, name, name, now, now]);
      row = { id };
    } else {
      await d1Run(event, 'UPDATE categories SET deleted_at = NULL, enabled = 1, updated_at = ? WHERE id = ?', [now, row.id]);
    }
    ids.push(row.id);
  }
  return ids;
};

const replaceCategories = async (event: H3Event, seriesId: string, names: string[]) => {
  const ids = await categoryIdsForNames(event, names);
  await d1Run(event, 'DELETE FROM series_categories WHERE series_id = ?', [seriesId]);
  for (let index = 0; index < ids.length; index += 1) {
    await d1Run(event, 'INSERT INTO series_categories (series_id, category_id, sort_order) VALUES (?, ?, ?)', [seriesId, ids[index], index]);
  }
};

const snapshotVersion = async (event: H3Event, seriesId: string, status: 'draft' | 'preview' | 'published') => {
  const series = (await listNormalizedSeries(event)).find((item) => item.id === seriesId);
  if (!series) return;
  const previous = await d1First<{ version_no: number }>(event, 'SELECT MAX(version_no) AS version_no FROM content_versions WHERE series_id = ?', [seriesId]);
  const version = Number(previous?.version_no || 0) + 1;
  const now = new Date().toISOString();
  const admin = event.context.adminSession as { id?: string } | undefined;
  if (status === 'published') await d1Run(event, "UPDATE content_versions SET status = 'superseded' WHERE series_id = ? AND status = 'published'", [seriesId]);
  await d1Run(event, `INSERT INTO content_versions
    (id, series_id, version_no, status, snapshot_json, created_by, created_at, published_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [
    `ver_${crypto.randomUUID()}`, seriesId, version, status, JSON.stringify(series), admin?.id || null, now, status === 'published' ? now : null,
  ]);
};

export const createNormalizedSeries = async (event: H3Event, input: SeriesMutationInput) => {
  const id = `sr-${crypto.randomUUID().slice(0, 8)}`;
  const slug = await makeSlug(event, input.title);
  const now = new Date().toISOString();
  await d1Run(event, `INSERT INTO series
    (id, slug, title, tagline, description, cover_url, backdrop_url, target_region,
     free_episode_count, price_cents, currency, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'USD', 'draft', ?, ?)`, [
    id, slug, input.title, input.title, input.description, defaultCoverUrl,
    defaultBackdropUrl, input.targetRegion, input.freeEpisodeCount, Math.round(input.price * 100), now, now,
  ]);
  await replaceCategories(event, id, input.genres);
  await snapshotVersion(event, id, 'draft');
  return (await listNormalizedSeries(event)).find((item) => item.id === id)!;
};

export const updateNormalizedSeries = async (event: H3Event, id: string, input: SeriesMutationInput) => {
  const existing = await d1First<{ id: string }>(event, 'SELECT id FROM series WHERE id = ? AND deleted_at IS NULL', [id]);
  if (!existing) throw createError({ statusCode: 404, statusMessage: 'Series not found' });
  const now = new Date().toISOString();
  await d1Run(event, `UPDATE series SET title = ?, description = ?, target_region = ?, free_episode_count = ?,
    price_cents = ?, updated_at = ? WHERE id = ?`, [input.title, input.description, input.targetRegion, input.freeEpisodeCount, Math.round(input.price * 100), now, id]);
  await replaceCategories(event, id, input.genres);
  await d1Run(event, 'UPDATE episodes SET is_free = CASE WHEN episode_no <= ? THEN 1 ELSE 0 END, updated_at = ? WHERE series_id = ?', [input.freeEpisodeCount, now, id]);
  await snapshotVersion(event, id, 'draft');
  return (await listNormalizedSeries(event)).find((item) => item.id === id)!;
};

export const updateNormalizedSeriesStatus = async (event: H3Event, id: string, publishStatus: PublishStatus) => {
  const series = (await listNormalizedSeries(event)).find((item) => item.id === id);
  if (!series) throw createError({ statusCode: 404, statusMessage: 'Series not found' });
  if (publishStatus === '已上架') {
    const incomplete = await d1First<{ count: number }>(event, `SELECT COUNT(*) AS count FROM episodes
      WHERE series_id = ? AND deleted_at IS NULL AND video_status <> 'ready'`, [id]);
    if (!series.episodeCount || Number(incomplete?.count || 0) > 0) {
      throw createError({ statusCode: 409, statusMessage: 'Episodes must finish transcoding before publishing' });
    }
  }
  const now = new Date().toISOString();
  const status = statusToDatabase[publishStatus];
  await d1Run(event, `UPDATE series SET status = ?, published_at = CASE WHEN ? = 'published' THEN ? ELSE published_at END,
    unpublished_at = CASE WHEN ? IN ('unpublished', 'rights_frozen') THEN ? ELSE unpublished_at END, updated_at = ? WHERE id = ?`,
  [status, status, now, status, now, now, id]);
  await snapshotVersion(event, id, publishStatus === '已上架' ? 'published' : 'draft');
  return (await listNormalizedSeries(event)).find((item) => item.id === id)!;
};

export const duplicateNormalizedSeries = async (event: H3Event, sourceId: string) => {
  const source = (await listNormalizedSeries(event)).find((item) => item.id === sourceId);
  if (!source) throw createError({ statusCode: 404, statusMessage: 'Series not found' });
  return createNormalizedSeries(event, {
    title: `${source.title} Copy`, description: source.description, genres: source.genres,
    targetRegion: source.targetRegion, freeEpisodeCount: source.freeEpisodeCount, price: source.price,
  });
};

export const softDeleteNormalizedSeries = async (event: H3Event, id: string) => {
  const row = await d1First<{ id: string; title: string }>(event, 'SELECT id, title FROM series WHERE id = ? AND deleted_at IS NULL', [id]);
  if (!row) throw createError({ statusCode: 404, statusMessage: 'Series not found' });
  const orderCount = await d1First<{ count: number }>(event, 'SELECT COUNT(*) AS count FROM orders WHERE series_id = ?', [id]);
  const now = new Date().toISOString();
  await d1Run(event, `UPDATE series SET status = 'unpublished', unpublished_at = ?, deleted_at = ?, updated_at = ? WHERE id = ?`, [now, now, now, id]);
  return { id, title: row.title, retainedOrderCount: Number(orderCount?.count || 0) };
};

export const listNormalizedTaxonomy = async (event: H3Event): Promise<TaxonomyItem[]> => {
  const rows = await d1All<TaxonomyRow>(event, `SELECT c.id, c.name, c.locale_name, c.color, c.enabled, NULL AS expires_at,
      COUNT(sc.series_id) AS content_count, '分类' AS type
    FROM categories c LEFT JOIN series_categories sc ON sc.category_id = c.id
    WHERE c.deleted_at IS NULL GROUP BY c.id
    UNION ALL
    SELECT t.id, t.name, t.locale_name, t.color, t.enabled, t.expires_at,
      COUNT(st.series_id) AS content_count, '标签' AS type
    FROM tags t LEFT JOIN series_tags st ON st.tag_id = t.id
    WHERE t.deleted_at IS NULL GROUP BY t.id
    ORDER BY type, name`);
  return rows.map((row) => ({
    id: row.id, name: row.name, localeName: row.locale_name, type: row.type, color: row.color,
    contentCount: Number(row.content_count), enabled: Boolean(row.enabled), expiresAt: row.expires_at || '—',
  }));
};

export const saveNormalizedTaxonomy = async (event: H3Event, items: TaxonomyItem[]) => {
  const now = new Date().toISOString();
  const categoryIds = new Set(items.filter((item) => item.type === '分类').map((item) => item.id));
  const tagIds = new Set(items.filter((item) => item.type === '标签').map((item) => item.id));
  const existingCategories = await d1All<{ id: string }>(event, 'SELECT id FROM categories WHERE deleted_at IS NULL');
  const existingTags = await d1All<{ id: string }>(event, 'SELECT id FROM tags WHERE deleted_at IS NULL');
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (item.type === '分类') {
      await d1Run(event, `INSERT INTO categories (id, name, locale_name, color, sort_order, enabled, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET name = excluded.name, locale_name = excluded.locale_name, color = excluded.color,
        sort_order = excluded.sort_order, enabled = excluded.enabled, updated_at = excluded.updated_at, deleted_at = NULL`,
      [item.id, item.name, item.localeName, item.color, index, item.enabled ? 1 : 0, now, now]);
    } else {
      await d1Run(event, `INSERT INTO tags (id, name, locale_name, color, sort_order, enabled, expires_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET name = excluded.name, locale_name = excluded.locale_name, color = excluded.color,
        sort_order = excluded.sort_order, enabled = excluded.enabled, expires_at = excluded.expires_at, updated_at = excluded.updated_at, deleted_at = NULL`,
      [item.id, item.name, item.localeName, item.color, index, item.enabled ? 1 : 0, item.expiresAt === '—' ? null : item.expiresAt, now, now]);
    }
  }
  for (const row of existingCategories) if (!categoryIds.has(row.id)) await d1Run(event, 'UPDATE categories SET deleted_at = ?, enabled = 0, updated_at = ? WHERE id = ?', [now, now, row.id]);
  for (const row of existingTags) if (!tagIds.has(row.id)) await d1Run(event, 'UPDATE tags SET deleted_at = ?, enabled = 0, updated_at = ? WHERE id = ?', [now, now, row.id]);
  return listNormalizedTaxonomy(event);
};

export { statusToDatabase, statusToPublic };
