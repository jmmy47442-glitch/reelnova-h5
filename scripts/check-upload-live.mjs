// Explicit integration check: real media Worker/R2, isolated in-memory SQL.
// node --env-file=.env scripts/check-upload-live.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { uploadFlow, videoFixture } from '../tests/helpers/upload-flow.mjs';

const env = process.env;
for (const key of ['CLOUDFLARE_MEDIA_WORKER_URL', 'CLOUDFLARE_MEDIA_WORKER_SECRET', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN']) {
  if (!env[key]) throw new Error(`Missing ${key}`);
}
const bucket = readFileSync(new URL('../wrangler.media.toml', import.meta.url), 'utf8').match(/bucket_name\s*=\s*"([^"]+)"/)?.[1];
assert.ok(bucket);
const h = uploadFlow({ workerUrl: env.CLOUDFLARE_MEDIA_WORKER_URL, workerSecret: env.CLOUDFLARE_MEDIA_WORKER_SECRET });
let cleanupFailed = false;
try {
  const small = videoFixture();
  const freeBox = Buffer.alloc(11 * 1024 * 1024);
  freeBox.writeUInt32BE(freeBox.length, 0); freeBox.write('free', 4);
  const large = new File([await small.arrayBuffer(), freeBox], 'multipart-fixture.mp4', { type: 'video/mp4', lastModified: 1 });
  for (const [index, file] of [small, large].entries()) {
    const started = Date.now();
    assert.equal(await h.upload(file, index + 1), 'ready');
    const row = h.db.prepare(`SELECT a.id FROM media_assets a JOIN episodes e ON e.active_media_asset_id = a.id WHERE e.episode_no = ?`).get(index + 1);
    const response = await h.fetchMedia(await h.preview(row.id));
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from(await file.arrayBuffer()));
    console.log(`PASS real R2 ${file.name}: create → parts → complete → ready → signed preview; ${file.size} bytes; ${Date.now() - started} ms`);
  }
} finally {
  // Exact keys originate exclusively from this run's isolated database.
  const rows = h.db.prepare('SELECT id, object_key, idempotency_key, source_etag FROM media_upload_sessions').all();
  for (const row of rows) {
    const asset = h.db.prepare('SELECT media_asset_id FROM media_upload_sessions WHERE id = ?').get(row.id).media_asset_id;
    if (!row.source_etag) await h.api.cancelEpisodeUpload(row.id).catch(() => { cleanupFailed = true; });
    const keys = [row.object_key, `_reelnova/upload-sessions/${row.idempotency_key}.json`];
    if (row.source_etag) {
      const httpEtag = encodeURIComponent(`"${row.source_etag.replace(/^"|"$/g, '')}"`);
      keys.push(`validation/${asset}/${httpEtag}.json`, `validation/playback-v2/${asset}/${httpEtag}.json`);
    }
    for (const key of keys) {
      const url = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/r2/buckets/${bucket}/objects/${key.split('/').map(encodeURIComponent).join('/')}`;
      const response = await fetch(url, { method: 'DELETE', headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` }, signal: AbortSignal.timeout(15000) });
      if (!response.ok && response.status !== 404) {
        cleanupFailed = true;
        console.error(`Cleanup failed HTTP ${response.status}: ${key}`);
      }
    }
  }
  h.db.close();
  if (cleanupFailed) throw new Error('Check failed test-object cleanup messages');
  console.log('PASS test R2 objects cleaned; production database was not modified');
}
