// Creates one isolated unpublished test series in real D1 and uploads a test
// video through real R2/Workflow/FFmpeg. Deletes only this run's records/files
// after a terminal callback. Run: node --env-file=.env scripts/check-upload-transcode-live.mjs
import assert from 'node:assert/strict';
import { uploadFlow, videoFixture } from '../tests/helpers/upload-flow.mjs';

const env = process.env;
for (const key of ['CLOUDFLARE_MEDIA_WORKER_URL', 'CLOUDFLARE_MEDIA_WORKER_SECRET', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_D1_DATABASE_ID', 'CLOUDFLARE_API_TOKEN']) {
  if (!env[key]) throw new Error(`Missing ${key}`);
}
const auth = { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, 'content-type': 'application/json' };
const accountBase = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}`;
const query = async body => {
  const response = await fetch(`${accountBase}/d1/database/${env.CLOUDFLARE_D1_DATABASE_ID}/query`, {
    method: 'POST', headers: auth, body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
  });
  const payload = await response.json();
  if (!response.ok || !payload.success || payload.result?.some(row => !row.success)) {
    throw new Error(`D1 check request failed (${response.status}): ${payload.errors?.map(e => e.message).join('; ') || 'query failed'}`);
  }
  return payload.result;
};
const d1 = {
  hasD1Connection: () => true,
  d1All: async (_event, sql, params = []) => (await query({ sql, params }))[0].results,
  d1First: async (_event, sql, params = []) => (await d1.d1All(null, sql, params))[0] || null,
  d1Run: async (_event, sql, params = []) => (await query({ sql, params }))[0],
  d1Batch: async (_event, batch) => query({ batch }),
};
const resume = process.argv[2] === '--resume' ? process.argv[3] : null;
if (resume && !/^upload-check-[0-9a-f-]{36}$/.test(resume)) throw new Error('Invalid test series ID');
const seriesId = resume || `upload-check-${crypto.randomUUID()}`;
const h = uploadFlow({ seriesId, d1, workerUrl: env.CLOUDFLARE_MEDIA_WORKER_URL, workerSecret: env.CLOUDFLARE_MEDIA_WORKER_SECRET });
let terminal = false;
let manifest;
let asset;
console.log(`Test series: ${seriesId}`);
try {
  if (resume) {
    const session = await d1.d1First(null, `SELECT s.id, s.status, a.id AS asset_id, a.status AS asset_status FROM media_upload_sessions s
      JOIN media_assets a ON a.id = s.media_asset_id JOIN episodes e ON e.id = a.episode_id
      JOIN series r ON r.id = e.series_id WHERE r.id = ? AND r.title = 'Upload pipeline verification (temporary)'`, [seriesId]);
    assert.ok(session, 'Temporary upload session not found');
    if (session.asset_status === 'failed') await h.api.retryTranscode(session.asset_id);
    else if (session.status !== 'completed') await h.api.completeEpisodeUpload(session.id, []);
  } else {
    const now = new Date().toISOString();
    await d1.d1Run(null, `INSERT INTO series (id, slug, title, status, free_episode_count, created_at, updated_at)
      VALUES (?, ?, 'Upload pipeline verification (temporary)', 'draft', 1, ?, ?)`, [seriesId, seriesId, now, now]);
    assert.equal(await h.upload(videoFixture('unsupported-video')), 'processing');
  }
  console.log('PASS real D1 → R2 upload → Workflow queued; waiting for FFmpeg callback');
  for (let attempt = 0; attempt < 60; attempt++) {
    asset = await d1.d1First(null, `SELECT a.*, j.status AS job_status, j.progress, j.error_message AS job_error
      FROM media_assets a JOIN episodes e ON e.id = a.episode_id
      LEFT JOIN transcode_jobs j ON j.media_asset_id = a.id WHERE e.series_id = ?`, [seriesId]);
    if (['ready', 'failed'].includes(asset?.status)) { terminal = true; break; }
    if (attempt % 3 === 0) console.log(`Transcode status: ${asset?.job_status || 'pending'}, ${asset?.progress || 0}%`);
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
  assert.equal(asset?.status, 'ready', asset?.job_error || 'Transcode did not finish within five minutes');
  const { data: grant } = await h.preview(asset.id, { format: 'json' });
  assert.equal(grant.delivery, 'hls');
  const master = await h.fetchMedia(grant.url);
  assert.equal(master.status, 200);
  const masterText = await master.text();
  const playlistPath = masterText.split(/\r?\n/).find(line => line && !line.startsWith('#'));
  assert.ok(playlistPath);
  const playlistUrl = new URL(playlistPath, grant.url);
  const playlist = await h.fetchMedia(playlistUrl);
  assert.equal(playlist.status, 200);
  const playlistText = await playlist.text();
  const files = [playlistText.match(/#EXT-X-MAP:URI="([^"]+)"/)?.[1], ...playlistText.split(/\r?\n/).filter(line => line && !line.startsWith('#'))];
  for (const file of files) {
    assert.ok(file);
    const response = await h.fetchMedia(new URL(file, playlistUrl));
    assert.equal(response.status, 200); assert.ok((await response.arrayBuffer()).byteLength > 0);
  }
  console.log('PASS real FFmpeg → signed production callback → D1 ready → HLS master/playlist/init/segments');
  const r2Base = `${accountBase}/r2/buckets/reelnova-media-private/objects/`;
  const readyKey = `hls/${asset.id}/${encodeURIComponent(asset.source_etag)}/ready.json`;
  const marker = await fetch(r2Base + readyKey.split('/').map(encodeURIComponent).join('/'), { headers: auth });
  assert.equal(marker.status, 200);
  manifest = await marker.json();
} finally {
  // Preserve a still-running task for diagnosis; never remove its source.
  if (terminal && manifest && asset) {
    const session = await d1.d1First(null, 'SELECT * FROM media_upload_sessions WHERE media_asset_id = ?', [asset.id]);
    const root = `hls/${asset.id}/${encodeURIComponent(asset.source_etag)}`;
    const prefix = `${root}/${manifest.buildId}/`;
    const keys = [asset.source_object_key, `_reelnova/upload-sessions/${session.idempotency_key}.json`, `${root}/ready.json`, `${prefix}master.m3u8`];
    for (const rendition of manifest.renditions) {
      keys.push(`${prefix}${rendition.id}/index.m3u8`, `${prefix}${rendition.id}/init.mp4`);
      for (let index = 0; index < rendition.segments; index++) keys.push(`${prefix}${rendition.id}/seg-${String(index).padStart(6, '0')}.m4s`);
    }
    for (const key of keys) {
      const response = await fetch(`${accountBase}/r2/buckets/reelnova-media-private/objects/${key.split('/').map(encodeURIComponent).join('/')}`, { method: 'DELETE', headers: auth, signal: AbortSignal.timeout(15000) });
      assert.ok(response.ok || response.status === 404, `Test object cleanup failed (${response.status}): ${key}`);
    }
    await d1.d1Batch(null, [
      { sql: 'UPDATE episodes SET active_media_asset_id = NULL WHERE series_id = ?', params: [seriesId] },
      { sql: 'DELETE FROM media_upload_sessions WHERE media_asset_id = ?', params: [asset.id] },
      { sql: 'DELETE FROM transcode_jobs WHERE media_asset_id = ?', params: [asset.id] },
      { sql: 'DELETE FROM media_assets WHERE id = ?', params: [asset.id] },
      { sql: 'DELETE FROM episodes WHERE series_id = ?', params: [seriesId] },
      { sql: 'DELETE FROM series WHERE id = ?', params: [seriesId] },
    ]);
    console.log('PASS temporary test records and R2/HLS objects removed');
  } else console.log(`Test records retained for diagnosis: ${seriesId}`);
  h.db.close();
}
