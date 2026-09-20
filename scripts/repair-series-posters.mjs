import { createHash, createHmac, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: {
  prepare: { type: 'boolean', default: false },
  apply: { type: 'boolean', default: false },
  'work-dir': { type: 'string', default: '/tmp/reelnova-poster-repair' },
  'ffmpeg-path': { type: 'string', default: process.env.FFMPEG_PATH || 'ffmpeg' },
  'env-file': { type: 'string', default: '.env' },
  'frame-time': { type: 'string', multiple: true, default: [] },
} });
const frameTimes = new Map(values['frame-time'].map(value => {
  const [id, seconds] = value.split('=');
  if (!id || !seconds || !Number.isFinite(Number(seconds)) || Number(seconds) < 0) {
    throw new Error('--frame-time must be SERIES_ID=SECONDS');
  }
  return [id, Number(seconds)];
}));
if (values.prepare && values.apply) throw new Error('Use --prepare and --apply separately to review images before publication.');
if (existsSync(values['env-file'])) process.loadEnvFile(values['env-file']);
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const databaseId = process.env.CLOUDFLARE_D1_DATABASE_ID;
const apiToken = process.env.CLOUDFLARE_API_TOKEN;
const mediaBase = String(process.env.CLOUDFLARE_MEDIA_WORKER_URL || '').replace(/\/$/, '');
const mediaSecret = process.env.CLOUDFLARE_MEDIA_WORKER_SECRET;
if (!accountId || !databaseId || !apiToken) throw new Error('Cloudflare account, database and API token are required.');
const apiBase = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}`;
const workDir = resolve(values['work-dir']);
const manifestPath = join(workDir, 'manifest.json');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

const cfRequest = async (path, body) => {
  const response = await fetch(`${apiBase}${path}`, {
    method: 'POST', signal: AbortSignal.timeout(30000),
    headers: { authorization: `Bearer ${apiToken}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok || !payload.success) throw new Error(payload.errors?.[0]?.message || `Cloudflare HTTP ${response.status}`);
  return payload.result;
};
const query = async (sql, params = []) => {
  const result = (await cfRequest(`/d1/database/${encodeURIComponent(databaseId)}/query`, { sql, params }))[0];
  if (!result.success) throw new Error(result.error || 'D1 query failed');
  return result;
};
const worker = async (path, body) => {
  if (!mediaBase || !mediaSecret) throw new Error('Media Worker URL and secret are required.');
  const raw = JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const response = await fetch(`${mediaBase}${path}`, {
    method: 'POST', body: raw, signal: AbortSignal.timeout(30000),
    headers: { 'content-type': 'application/json', 'x-reelnova-timestamp': timestamp,
      'x-reelnova-signature': createHmac('sha256', mediaSecret).update(`${timestamp}.${raw}`).digest('hex') },
  });
  if (!response.ok) throw new Error(`Media Worker ${path}: HTTP ${response.status}`);
  return response.json();
};
const missingImage = value => !value || value.includes('/api/media/poster/')
  || /^\/posters\/vows-vengeance(?:-wide)?\.jpg$/.test(value)
  || /cloudflarestream\.com|videodelivery\.net/i.test(value);
const rows = (await query(`SELECT s.id, s.title, s.cover_url, s.backdrop_url,
  e.id AS episode_id, e.duration_seconds, a.id AS asset_id, a.storage_provider,
  a.source_object_key, a.stream_uid, a.hls_url
  FROM series s JOIN episodes e ON e.id = (
    SELECT ep.id FROM episodes ep JOIN media_assets ma ON ma.id = ep.active_media_asset_id
    WHERE ep.series_id = s.id AND ep.deleted_at IS NULL AND ep.video_status = 'ready'
      AND ma.deleted_at IS NULL AND ma.status = 'ready' ORDER BY ep.episode_no LIMIT 1)
  JOIN media_assets a ON a.id = e.active_media_asset_id
  WHERE s.deleted_at IS NULL ORDER BY s.id`)).results;
const candidates = rows.filter(row => missingImage(row.cover_url) || missingImage(row.backdrop_url));
console.log(JSON.stringify(candidates.map(row => ({ id: row.id, title: row.title,
  cover: missingImage(row.cover_url), backdrop: missingImage(row.backdrop_url) })), null, 2));
if (!values.prepare && !values.apply) {
  console.log('Read-only scan. Use --prepare to extract images, review them, then --apply to upload and update D1.');
  process.exit(0);
}

const ffmpeg = args => {
  try {
    execFileSync(values['ffmpeg-path'], ['-hide_banner', '-loglevel', 'error', '-y', ...args],
      { stdio: 'pipe', timeout: 120000 });
  } catch {
    // FFmpeg errors can include signed source URLs; keep them out of logs.
    throw new Error('Frame extraction failed. Check the FFmpeg executable and source availability.');
  }
};
if (values.prepare) {
  mkdirSync(workDir, { recursive: true });
  const manifest = { version: 1, accountId, databaseId, items: [] };
  for (const row of candidates) {
    const frame = join(workDir, `${row.id}-frame.jpg`);
    const time = frameTimes.get(row.id) ?? Math.max(1, Math.min(20, Number(row.duration_seconds || 10) * 0.2));
    if (row.duration_seconds > 0 && time >= row.duration_seconds) throw new Error(`Frame time exceeds duration: ${row.id}`);
    if (row.storage_provider === 'stream' && /^[a-f0-9]{32}$/i.test(row.stream_uid || '')) {
      const source = new URL(row.hls_url);
      if (source.protocol !== 'https:' || !/^customer-[a-z0-9]+\.cloudflarestream\.com$/i.test(source.hostname)) {
        throw new Error(`Unexpected Stream host for ${row.id}`);
      }
      const { token } = await cfRequest(`/stream/${row.stream_uid}/token`, {});
      source.pathname = `/${token}/thumbnails/thumbnail.jpg`;
      source.search = new URLSearchParams({ time: `${time}s`, width: '1280', height: '720', fit: 'clip' }).toString();
      const response = await fetch(source, { signal: AbortSignal.timeout(60000) });
      if (!response.ok || !response.headers.get('content-type')?.startsWith('image/')) {
        throw new Error(`Cannot extract Stream frame for ${row.id}: HTTP ${response.status}`);
      }
      writeFileSync(frame, Buffer.from(await response.arrayBuffer()));
    } else if (row.storage_provider === 'r2' && row.source_object_key?.startsWith('originals/')) {
      const grant = await worker('/original/token', { key: row.source_object_key, assetId: row.asset_id,
        exp: Math.floor(Date.now() / 1000) + 900, delivery: 'mp4' });
      ffmpeg(['-ss', String(time), '-i', grant.url, '-frames:v', '1', '-q:v', '2', frame]);
    } else {
      throw new Error(`Unsupported video source for ${row.id}`);
    }
    const images = {};
    for (const [field, size] of [['cover_url', '600:900'], ['backdrop_url', '1280:720']]) {
      if (!missingImage(row[field])) continue;
      const file = `${row.id}-${field}.jpg`;
      ffmpeg(['-i', frame, '-vf', `scale=${size}:force_original_aspect_ratio=increase,crop=${size},setsar=1`,
        '-frames:v', '1', '-q:v', '2', join(workDir, file)]);
      images[field] = { file, sha256: hash(readFileSync(join(workDir, file))),
        objectKey: `posters/${row.id}/cover-${randomUUID()}.jpg` };
    }
    manifest.items.push({ id: row.id, title: row.title, frameTime: time, episodeId: row.episode_id, assetId: row.asset_id,
      before: { cover_url: row.cover_url, backdrop_url: row.backdrop_url }, images });
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    console.log(`Prepared ${row.title}`);
  }
  console.log(`Review images and original URLs in ${manifestPath}`);
} else {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest.version !== 1 || manifest.accountId !== accountId || manifest.databaseId !== databaseId) {
    throw new Error('Manifest does not match this database.');
  }
  for (const item of manifest.items) {
    const row = rows.find(row => row.id === item.id);
    if (item.applied && row?.cover_url === item.after.cover_url && row?.backdrop_url === item.after.backdrop_url) {
      console.log(`Already repaired ${item.title}`);
      continue;
    }
    if (!row || row.cover_url !== item.before.cover_url || row.backdrop_url !== item.before.backdrop_url
      || row.asset_id !== item.assetId) throw new Error(`Content changed since preparation: ${item.id}`);
    const after = { ...item.before };
    for (const [field, image] of Object.entries(item.images)) {
      if (!['cover_url', 'backdrop_url'].includes(field) || !missingImage(row[field])) throw new Error('Refusing to replace a custom image.');
      const bytes = readFileSync(join(workDir, image.file));
      if (hash(bytes) !== image.sha256) throw new Error(`Prepared image changed: ${image.file}`);
      const upload = await worker('/images/uploads', { seriesId: item.id, objectKey: image.objectKey,
        contentType: 'image/jpeg', fileSizeBytes: bytes.length });
      const response = await fetch(upload.uploadUrl, { method: 'PUT', body: bytes,
        signal: AbortSignal.timeout(60000), headers: { authorization: `Bearer ${upload.uploadToken}`, 'content-type': 'image/jpeg' } });
      if (!response.ok) throw new Error(`Image upload failed: HTTP ${response.status}`);
      const verified = await worker('/images/verify', { seriesId: item.id, objectKey: image.objectKey });
      const publicImage = await fetch(verified.publicUrl, { signal: AbortSignal.timeout(30000) });
      if (!publicImage.ok || hash(Buffer.from(await publicImage.arrayBuffer())) !== image.sha256) {
        throw new Error(`Public image verification failed for ${item.id}`);
      }
      after[field] = verified.publicUrl;
    }
    // Compare-and-swap also protects an admin upload made during publication.
    const result = await query(`UPDATE series SET cover_url = ?, backdrop_url = ?, updated_at = ?
      WHERE id = ? AND cover_url IS ? AND backdrop_url IS ? AND deleted_at IS NULL
      AND EXISTS (SELECT 1 FROM episodes WHERE id = ? AND active_media_asset_id = ? AND deleted_at IS NULL)`,
    [after.cover_url, after.backdrop_url, new Date().toISOString(), item.id,
      item.before.cover_url, item.before.backdrop_url, item.episodeId, item.assetId]);
    if (result.meta?.changes !== 1) throw new Error(`Concurrent update for ${item.id}; no cover was overwritten.`);
    item.after = after;
    item.applied = true;
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    console.log(`Repaired ${item.title}`);
  }
}
