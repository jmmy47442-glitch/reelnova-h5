import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const assetId = 'media_11111111-1111-4111-8111-111111111111';
const jobId = `transcode_${assetId}`;

const harness = () => {
  const db = new DatabaseSync(':memory:');
  const directory = new URL('../migrations/', import.meta.url);
  for (const file of readdirSync(directory).filter(name => name.endsWith('.sql')).sort()) {
    db.exec(readFileSync(new URL(file, directory), 'utf8'));
  }
  db.exec(`
    INSERT INTO series (id, slug, title, status, created_at, updated_at) VALUES ('series', 'series', 'Series', 'processing', 'now', 'now');
    INSERT INTO episodes (id, series_id, episode_no, title, video_status, created_at, updated_at)
      VALUES ('episode', 'series', 1, 'Episode', 'processing', 'now', 'now');
    INSERT INTO media_assets (id, episode_id, storage_provider, source_object_key, source_file_name, source_content_type,
      source_size_bytes, source_etag, validation_status, status, created_at, updated_at)
      VALUES ('${assetId}', 'episode', 'r2', 'originals/series/episode/${assetId}/video.mov', 'video.mov',
        'video/quicktime', 1024, 'abcdef123456', 'pending', 'processing', 'now', 'now');
    UPDATE episodes SET active_media_asset_id = '${assetId}' WHERE id = 'episode';
    INSERT INTO transcode_jobs (id, media_asset_id, provider_job_id, status, progress, created_at, updated_at)
      VALUES ('${jobId}', '${assetId}', '${jobId}', 'queued', 0, 'now', 'now');
  `);
  const d1 = {
    d1First: async (_event, sql, params = []) => db.prepare(sql).get(...params) || null,
    d1Batch: async (_event, statements) => {
      db.exec('BEGIN');
      try {
        const results = statements.map(({ sql, params = [] }) => db.prepare(sql).run(...params));
        db.exec('COMMIT');
        return results;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
  };
  const source = readFileSync(new URL('../server/api/internal/media/transcode.post.ts', import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const exports = {};
  runInNewContext(code, {
    exports,
    require: name => {
      if (name === '~/server/utils/cloudflare-d1') return d1;
      if (name === '~/server/utils/internal-worker-auth') return { verifyMediaWorkerRequest: async () => true };
      throw new Error(`Unexpected import ${name}`);
    },
    defineEventHandler: handler => handler,
    readRawBody: async event => event.body,
    createError: ({ statusCode, statusMessage }) => Object.assign(new Error(statusMessage), { statusCode }),
  });
  const call = body => exports.default({ body: JSON.stringify(body) });
  return { db, call };
};

test('transcode callback advances processing media to ready HLS atomically', async () => {
  const h = harness();
  try {
    await h.call({ jobId, assetId, status: 'processing', progress: 5 });
    assert.equal(h.db.prepare('SELECT progress FROM transcode_jobs').get().progress, 5);
    const sourceEtag = 'abcdef123456';
    const hlsPrefix = `hls/${assetId}/${sourceEtag}/11111111-1111-4111-8111-111111111111/`;
    await h.call({
      jobId, assetId, status: 'ready', progress: 100, sourceEtag, hlsPrefix,
      media: { width: 1080, height: 1920, durationSeconds: 92.4, hasVideo: true, hasAudio: true },
      renditions: [{ id: 'v360' }],
    });
    assert.equal(h.db.prepare('SELECT status FROM transcode_jobs').get().status, 'ready');
    const asset = h.db.prepare('SELECT status, validation_status, hls_url FROM media_assets').get();
    assert.equal(asset.status, 'ready');
    assert.equal(asset.validation_status, 'valid');
    assert.equal(asset.hls_url, hlsPrefix);
    assert.equal(h.db.prepare('SELECT video_status FROM episodes').get().video_status, 'ready');
    assert.equal(h.db.prepare('SELECT status FROM series').get().status, 'draft');
  } finally { h.db.close(); }
});

test('transcode failure preserves its actionable error', async () => {
  const h = harness();
  try {
    await h.call({ jobId, assetId, status: 'failed', errorMessage: 'Decoder rejected source' });
    assert.equal(h.db.prepare('SELECT status FROM transcode_jobs').get().status, 'failed');
    assert.equal(h.db.prepare('SELECT validation_error FROM media_assets').get().validation_error, 'Decoder rejected source');
    assert.equal(h.db.prepare('SELECT video_status FROM episodes').get().video_status, 'failed');
  } finally { h.db.close(); }
});
