PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS series (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL COLLATE NOCASE UNIQUE,
  title TEXT NOT NULL,
  tagline TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  cover_url TEXT NOT NULL DEFAULT '',
  backdrop_url TEXT NOT NULL DEFAULT '',
  badge TEXT,
  target_region TEXT NOT NULL DEFAULT 'Global',
  language TEXT NOT NULL DEFAULT 'en',
  subtitle_languages TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(subtitle_languages)),
  cast_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(cast_json)),
  director TEXT NOT NULL DEFAULT '',
  copyright_notice TEXT NOT NULL DEFAULT '',
  free_episode_count INTEGER NOT NULL DEFAULT 0 CHECK (free_episode_count >= 0),
  price_cents INTEGER NOT NULL DEFAULT 0 CHECK (price_cents >= 0),
  original_price_cents INTEGER CHECK (original_price_cents IS NULL OR original_price_cents >= 0),
  currency TEXT NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'processing', 'scheduled', 'published', 'unpublished', 'rights_frozen')),
  published_at TEXT,
  scheduled_at TEXT,
  unpublished_at TEXT,
  seo_title TEXT NOT NULL DEFAULT '',
  seo_description TEXT NOT NULL DEFAULT '',
  share_image_url TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_series_status_published ON series(status, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_series_updated ON series(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_series_deleted ON series(deleted_at);

CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  locale_name TEXT NOT NULL DEFAULT '',
  locale TEXT NOT NULL DEFAULT 'en-US',
  color TEXT NOT NULL DEFAULT '#5d6bff',
  icon_url TEXT NOT NULL DEFAULT '',
  cover_url TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS tags (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  locale_name TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT '#5d6bff',
  sort_order INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS series_categories (
  series_id TEXT NOT NULL,
  category_id TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(series_id, category_id),
  FOREIGN KEY(series_id) REFERENCES series(id) ON DELETE CASCADE,
  FOREIGN KEY(category_id) REFERENCES categories(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_series_categories_category ON series_categories(category_id, series_id);

CREATE TABLE IF NOT EXISTS series_tags (
  series_id TEXT NOT NULL,
  tag_id TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(series_id, tag_id),
  FOREIGN KEY(series_id) REFERENCES series(id) ON DELETE CASCADE,
  FOREIGN KEY(tag_id) REFERENCES tags(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_series_tags_tag ON series_tags(tag_id, series_id);

CREATE TABLE IF NOT EXISTS episodes (
  id TEXT PRIMARY KEY,
  series_id TEXT NOT NULL,
  episode_no INTEGER NOT NULL CHECK (episode_no > 0),
  title TEXT NOT NULL,
  duration_seconds INTEGER NOT NULL DEFAULT 0 CHECK (duration_seconds >= 0),
  is_free INTEGER NOT NULL DEFAULT 0 CHECK (is_free IN (0, 1)),
  video_status TEXT NOT NULL DEFAULT 'waiting_upload' CHECK (video_status IN ('waiting_upload', 'uploading', 'validating', 'processing', 'ready', 'failed')),
  active_media_asset_id TEXT,
  thumbnail_url TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  UNIQUE(series_id, episode_no),
  FOREIGN KEY(series_id) REFERENCES series(id) ON DELETE CASCADE,
  FOREIGN KEY(active_media_asset_id) REFERENCES media_assets(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_episodes_series_no ON episodes(series_id, episode_no);
CREATE INDEX IF NOT EXISTS idx_episodes_status ON episodes(video_status, updated_at);

CREATE TABLE IF NOT EXISTS media_assets (
  id TEXT PRIMARY KEY,
  episode_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'video' CHECK (kind IN ('video', 'subtitle', 'cover', 'thumbnail', 'preview')),
  storage_provider TEXT NOT NULL CHECK (storage_provider IN ('r2', 'stream')),
  source_object_key TEXT,
  stream_uid TEXT UNIQUE,
  source_file_name TEXT NOT NULL,
  source_content_type TEXT NOT NULL,
  source_size_bytes INTEGER NOT NULL CHECK (source_size_bytes > 0),
  source_etag TEXT,
  width INTEGER,
  height INTEGER,
  duration_seconds REAL,
  has_video INTEGER CHECK (has_video IN (0, 1)),
  has_audio INTEGER CHECK (has_audio IN (0, 1)),
  validation_status TEXT NOT NULL DEFAULT 'pending' CHECK (validation_status IN ('pending', 'valid', 'invalid')),
  validation_error TEXT,
  hls_url TEXT,
  dash_url TEXT,
  thumbnail_url TEXT,
  status TEXT NOT NULL DEFAULT 'uploading' CHECK (status IN ('uploading', 'uploaded', 'processing', 'ready', 'failed', 'superseded')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  FOREIGN KEY(episode_id) REFERENCES episodes(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_media_assets_episode ON media_assets(episode_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_media_assets_status ON media_assets(status, updated_at);

CREATE TABLE IF NOT EXISTS media_upload_sessions (
  id TEXT PRIMARY KEY,
  media_asset_id TEXT NOT NULL,
  provider_upload_id TEXT NOT NULL UNIQUE,
  object_key TEXT NOT NULL UNIQUE,
  part_size_bytes INTEGER NOT NULL CHECK (part_size_bytes >= 5242880),
  file_size_bytes INTEGER NOT NULL CHECK (file_size_bytes > 0),
  uploaded_bytes INTEGER NOT NULL DEFAULT 0 CHECK (uploaded_bytes >= 0),
  status TEXT NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'uploading', 'completing', 'completed', 'aborted', 'expired', 'failed')),
  expires_at TEXT NOT NULL,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(media_asset_id) REFERENCES media_assets(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_upload_sessions_asset ON media_upload_sessions(media_asset_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_upload_sessions_status ON media_upload_sessions(status, expires_at);

CREATE TABLE IF NOT EXISTS transcode_jobs (
  id TEXT PRIMARY KEY,
  media_asset_id TEXT NOT NULL,
  provider_job_id TEXT UNIQUE,
  attempt INTEGER NOT NULL DEFAULT 1 CHECK (attempt > 0),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'processing', 'ready', 'failed', 'cancelled')),
  progress INTEGER NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  error_code TEXT,
  error_message TEXT,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(media_asset_id) REFERENCES media_assets(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_transcode_jobs_asset ON transcode_jobs(media_asset_id, attempt DESC);
CREATE INDEX IF NOT EXISTS idx_transcode_jobs_status ON transcode_jobs(status, updated_at);

CREATE TABLE IF NOT EXISTS content_versions (
  id TEXT PRIMARY KEY,
  series_id TEXT NOT NULL,
  version_no INTEGER NOT NULL CHECK (version_no > 0),
  status TEXT NOT NULL CHECK (status IN ('draft', 'preview', 'published', 'superseded')),
  snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)),
  created_by TEXT,
  created_at TEXT NOT NULL,
  published_at TEXT,
  UNIQUE(series_id, version_no),
  FOREIGN KEY(series_id) REFERENCES series(id) ON DELETE CASCADE,
  FOREIGN KEY(created_by) REFERENCES admin_accounts(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_content_versions_series ON content_versions(series_id, version_no DESC);

CREATE TRIGGER IF NOT EXISTS protect_ordered_series_delete
BEFORE DELETE ON series
WHEN EXISTS (SELECT 1 FROM orders WHERE orders.series_id = OLD.id LIMIT 1)
BEGIN
  SELECT RAISE(ABORT, 'series with orders must be soft deleted');
END;

-- Migrate the previous JSON configuration when it exists. New installations simply
-- create empty normalized tables and can import content through the admin UI.
INSERT OR IGNORE INTO categories
  (id, name, locale_name, color, sort_order, enabled, created_at, updated_at, deleted_at)
SELECT
  json_extract(item.value, '$.id'),
  json_extract(item.value, '$.name'),
  COALESCE(json_extract(item.value, '$.localeName'), ''),
  COALESCE(json_extract(item.value, '$.color'), '#5d6bff'),
  CAST(item.key AS INTEGER),
  CASE WHEN json_extract(item.value, '$.enabled') THEN 1 ELSE 0 END,
  datetime('now'), datetime('now'), NULL
FROM home_config config, json_each(config.payload) item
WHERE config.id = 'taxonomy' AND json_extract(item.value, '$.type') = '分类';

INSERT OR IGNORE INTO tags
  (id, name, locale_name, color, sort_order, enabled, expires_at, created_at, updated_at, deleted_at)
SELECT
  json_extract(item.value, '$.id'),
  json_extract(item.value, '$.name'),
  COALESCE(json_extract(item.value, '$.localeName'), ''),
  COALESCE(json_extract(item.value, '$.color'), '#5d6bff'),
  CAST(item.key AS INTEGER),
  CASE WHEN json_extract(item.value, '$.enabled') THEN 1 ELSE 0 END,
  CASE WHEN json_extract(item.value, '$.expiresAt') = '—' THEN NULL ELSE json_extract(item.value, '$.expiresAt') END,
  datetime('now'), datetime('now'), NULL
FROM home_config config, json_each(config.payload) item
WHERE config.id = 'taxonomy' AND json_extract(item.value, '$.type') = '标签';

INSERT OR IGNORE INTO categories
  (id, name, locale_name, color, sort_order, enabled, created_at, updated_at, deleted_at)
SELECT DISTINCT
  'cat-legacy-' || hex(genre.value),
  genre.value, genre.value, '#5d6bff', 100, 1, datetime('now'), datetime('now'), NULL
FROM home_config config, json_each(config.payload) item, json_each(json_extract(item.value, '$.genres')) genre
WHERE config.id = 'managed-series';

INSERT OR IGNORE INTO tags
  (id, name, locale_name, color, sort_order, enabled, created_at, updated_at, deleted_at)
SELECT DISTINCT
  'tag-legacy-' || lower(replace(json_extract(item.value, '$.badge'), ' ', '-')),
  json_extract(item.value, '$.badge'), json_extract(item.value, '$.badge'), '#5d6bff', 100, 1,
  datetime('now'), datetime('now'), NULL
FROM home_config config, json_each(config.payload) item
WHERE config.id = 'managed-series' AND COALESCE(json_extract(item.value, '$.badge'), '') <> '';

INSERT OR IGNORE INTO series
  (id, slug, title, tagline, description, cover_url, backdrop_url, badge, target_region,
   cast_json, free_episode_count, price_cents, original_price_cents, currency, status,
   published_at, created_at, updated_at)
SELECT
  json_extract(item.value, '$.id'), json_extract(item.value, '$.slug'), json_extract(item.value, '$.title'),
  COALESCE(json_extract(item.value, '$.tagline'), ''), COALESCE(json_extract(item.value, '$.description'), ''),
  COALESCE(json_extract(item.value, '$.coverUrl'), ''), COALESCE(json_extract(item.value, '$.backdropUrl'), ''),
  json_extract(item.value, '$.badge'), COALESCE(json_extract(item.value, '$.targetRegion'), 'Global'),
  COALESCE(json_extract(item.value, '$.cast'), '[]'), COALESCE(json_extract(item.value, '$.freeEpisodeCount'), 0),
  CAST(ROUND(COALESCE(json_extract(item.value, '$.price'), 0) * 100) AS INTEGER),
  CASE WHEN json_type(item.value, '$.originalPrice') IS NULL THEN NULL ELSE CAST(ROUND(json_extract(item.value, '$.originalPrice') * 100) AS INTEGER) END,
  'USD',
  CASE json_extract(item.value, '$.publishStatus')
    WHEN '已上架' THEN 'processing' WHEN '处理中' THEN 'processing' WHEN '待发布' THEN 'scheduled'
    WHEN '已下架' THEN 'unpublished' WHEN '版权冻结' THEN 'rights_frozen' ELSE 'draft' END,
  NULL,
  datetime('now'), datetime('now')
FROM home_config config, json_each(config.payload) item
WHERE config.id = 'managed-series';

INSERT OR IGNORE INTO series_categories (series_id, category_id, sort_order)
SELECT json_extract(item.value, '$.id'), category.id, CAST(genre.key AS INTEGER)
FROM home_config config, json_each(config.payload) item, json_each(json_extract(item.value, '$.genres')) genre
JOIN categories category ON category.name = genre.value COLLATE NOCASE
WHERE config.id = 'managed-series';

INSERT OR IGNORE INTO series_tags (series_id, tag_id, sort_order)
SELECT json_extract(item.value, '$.id'), tag.id, 0
FROM home_config config, json_each(config.payload) item
JOIN tags tag ON tag.name = json_extract(item.value, '$.badge') COLLATE NOCASE
WHERE config.id = 'managed-series' AND COALESCE(json_extract(item.value, '$.badge'), '') <> '';

INSERT OR IGNORE INTO episodes
  (id, series_id, episode_no, title, duration_seconds, is_free, video_status, created_at, updated_at)
SELECT
  json_extract(item.value, '$.id') || '-ep-' || json_extract(episode.value, '$.episodeNo'),
  json_extract(item.value, '$.id'), json_extract(episode.value, '$.episodeNo'),
  COALESCE(json_extract(episode.value, '$.title'), 'Episode ' || json_extract(episode.value, '$.episodeNo')),
  CAST(substr(json_extract(episode.value, '$.duration'), 1, instr(json_extract(episode.value, '$.duration'), ':') - 1) AS INTEGER) * 60
    + CAST(substr(json_extract(episode.value, '$.duration'), instr(json_extract(episode.value, '$.duration'), ':') + 1) AS INTEGER),
  CASE WHEN json_extract(episode.value, '$.isFree') THEN 1 ELSE 0 END,
  'waiting_upload', datetime('now'), datetime('now')
FROM home_config config, json_each(config.payload) item, json_each(json_extract(item.value, '$.episodes')) episode
WHERE config.id = 'managed-series';

INSERT OR IGNORE INTO content_versions
  (id, series_id, version_no, status, snapshot_json, created_at, published_at)
SELECT
  'ver-' || json_extract(item.value, '$.id') || '-1', json_extract(item.value, '$.id'), 1,
  'draft', item.value, datetime('now'), NULL
FROM home_config config, json_each(config.payload) item
WHERE config.id = 'managed-series';
