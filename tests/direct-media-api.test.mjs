import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const createError = ({ statusMessage, ...data }) => Object.assign(new Error(statusMessage), data);
const harness = () => {
  const db = new DatabaseSync(':memory:');
  const directory = new URL('../migrations/', import.meta.url);
  for (const file of readdirSync(directory).filter(name => name.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(file, directory), 'utf8'));
  db.exec(`
    INSERT INTO users (user_id, email, created_at, updated_at, last_seen_at) VALUES ('user', 'user@example.com', 'now', 'now', 'now');
    INSERT INTO series (id, slug, title, status, created_at, updated_at) VALUES ('series', 'series', 'Series', 'processing', 'now', 'now');
    INSERT INTO episodes (id, series_id, episode_no, title, is_free, video_status, created_at, updated_at)
      VALUES ('episode', 'series', 1, 'Episode 1', 1, 'uploading', 'now', 'now');
    INSERT INTO media_assets (id, episode_id, storage_provider, source_object_key, source_file_name, source_content_type, source_size_bytes, status, created_at, updated_at)
      VALUES ('asset', 'episode', 'r2', 'originals/series/episode/asset/video.mp4', 'video.mp4', 'video/mp4', 1024, 'uploading', 'now', 'now');
    UPDATE episodes SET active_media_asset_id = 'asset';
    INSERT INTO media_upload_sessions (id, media_asset_id, provider_upload_id, object_key, part_size_bytes, file_size_bytes, status, expires_at,
      idempotency_key, r2_completion_key, stream_idempotency_key, created_at, updated_at)
      VALUES ('upload', 'asset', 'provider-upload', 'originals/series/episode/asset/video.mp4', 5242880, 1024, 'uploading', '2099-01-01',
        'upload:key', 'r2:upload', 'legacy-placeholder', 'now', 'now');
  `);
  let workerPlayback = { url: 'https://media.example.test/original/signed' };
  let valid = true, workerCalls = 0, failSessionWrite = false, established = 0;
  const d1 = {
    hasD1Connection: () => true,
    d1First: async (_e, sql, params = []) => db.prepare(sql).get(...params) || null,
    d1Run: async (_e, sql, params = []) => {
      if (failSessionWrite && sql.includes('r2_completed_at = COALESCE')) { failSessionWrite = false; throw new Error('D1 temporary failure'); }
      return db.prepare(sql).run(...params);
    },
    d1Batch: async (_e, statements) => {
      db.exec('BEGIN');
      try { const results = statements.map(({sql, params = []}) => db.prepare(sql).run(...params)); db.exec('COMMIT'); return results; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    },
  };
  const imports = {
    './cloudflare-d1': d1, '~/server/utils/cloudflare-d1': d1,
    './admin-audit': { recordAdminAudit: async () => {} },
    './media-pipeline': { mediaWorkerRequest: async (_e, path) => {
      assert.equal(path, '/uploads/provider-upload/complete'); workerCalls++;
      return valid ? { etag: 'etag', valid: true, media: { width: 160, height: 90, durationSeconds: 12 } }
        : { etag: 'etag', valid: false, errorMessage: 'Unsupported codec' };
    } },
    '~/server/utils/media-pipeline': { mediaWorkerRequest: async (_e, path) => {
      assert.equal(path, '/original/token'); workerCalls++;
      assert.equal(established > 0, true);
      return workerPlayback;
    } },
    '~/server/utils/response': { ok: data => ({ data }) },
    '~/server/utils/user-profile': { assertUserEnabled: async () => {}, upsertUserProfile: async () => {} },
    '~/server/utils/user-auth': { getUserSession: async event => event.loggedOut ? null : { userId: 'user' } },
    '~/server/utils/managed-content': { getPublicSeries: async () => [] },
    '~/server/utils/playback-authorization': { getPlaybackAuthorizationSecret: () => 'secret', signPlaybackAuthorization: async () => 'tracking' },
    '~/server/utils/playback-security': {
      enforcePlaybackRateLimits: async () => {}, getPlaybackClientContext: async () => ({}),
      establishPlaybackSession: async event => { if (event.deviceBlocked) throw createError({ statusCode: 429, statusMessage: 'Device limit' }); established++; },
    },
  };
  const load = name => {
    const exports = {};
    const source = readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
    const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
    runInNewContext(code, {
      exports, require: name => { assert.ok(imports[name], `Unexpected import ${name}`); return imports[name]; },
      URL, AbortSignal, createError, defineEventHandler: fn => fn, getQuery: event => event.query,
      getRequestURL: () => new URL('https://app.example.test/api/playback'),
      getHeader: () => undefined, setHeader: (event, name, value) => { (event.headers ||= {})[name] = value; },
      useRuntimeConfig: () => ({ cloudflareAccountId: 'account', cloudflareApiToken: 'api-token' }),
      fetch: async (url, options) => {
        assert.equal(url, 'https://api.cloudflare.com/client/v4/accounts/account/stream/0123456789abcdef0123456789abcdef/token');
        assert.equal(options.method, 'POST');
        return { ok: true, status: 200, json: async () => ({ success: true, result: { token: 'signed-stream-token-1234567890' } }) };
      },
    });
    return exports;
  };
  const upload = load('server/utils/media-upload-state.ts');
  return { db, upload, playback: load('server/api/playback.get.ts').default,
    setWorkerPlayback: value => { workerPlayback = value; },
    setInvalid: () => { valid = false; }, failWrite: () => { failSessionWrite = true; }, calls: () => workerCalls };
};
const complete = async h => h.upload.completeMediaUpload({}, await h.upload.getMediaUploadState({}, 'upload'), [{ partNumber: 1, etag: 'part' }]);
const publish = h => h.db.exec("UPDATE series SET status = 'published'");
const event = extra => ({ query: { seriesId: 'series', episodeNo: 1, sessionId: 'session' }, context: {}, ...extra });

test('completion makes the actual episode ready, without a Stream UID or transcode job, and is repeatable', async () => {
  const h = harness();
  try {
    assert.equal((await complete(h)).status, 'ready');
    assert.equal(h.db.prepare('SELECT status FROM media_upload_sessions').get().status, 'completed');
    assert.equal(h.db.prepare('SELECT video_status FROM episodes').get().video_status, 'ready');
    assert.equal(h.db.prepare('SELECT duration_seconds FROM episodes').get().duration_seconds, 12);
    assert.equal(h.db.prepare('SELECT status FROM series').get().status, 'draft');
    assert.equal(h.db.prepare('SELECT stream_uid FROM media_assets').get().stream_uid, null);
    assert.equal(h.db.prepare('SELECT COUNT(*) AS count FROM transcode_jobs').get().count, 0);
    assert.equal((await complete(h)).status, 'ready');
    assert.equal(h.calls(), 1);
  } finally { h.db.close(); }
});

test('invalid MP4 never becomes publishable or playable', async () => {
  const h = harness();
  try {
    h.setInvalid();
    assert.equal((await complete(h)).status, 'failed');
    assert.equal(h.db.prepare('SELECT video_status FROM episodes').get().video_status, 'failed');
    assert.equal(h.db.prepare('SELECT validation_status FROM media_assets').get().validation_status, 'invalid');
    publish(h);
    await assert.rejects(h.playback(event()), error => error.statusCode === 503);
    assert.equal(h.calls(), 1);
  } finally { h.db.close(); }
});

test('interrupted D1 completion can recover from stored parts without another upload', async () => {
  const h = harness();
  try {
    h.failWrite();
    await assert.rejects(complete(h), /D1 temporary failure/);
    const state = await h.upload.getMediaUploadState({}, 'upload');
    assert.equal(state.status, 'completing');
    assert.equal((await h.upload.completeMediaUpload({}, state)).status, 'ready');
    assert.equal(h.db.prepare('SELECT COUNT(*) AS count FROM media_assets').get().count, 1);
  } finally { h.db.close(); }
});

test('stale validation cannot reactivate a superseded asset', async () => {
  const h = harness();
  try {
    h.db.exec("UPDATE media_assets SET status = 'superseded', deleted_at = 'now'; UPDATE episodes SET active_media_asset_id = NULL, video_status = 'waiting_upload'");
    await h.upload.applyDirectMediaValidation({}, 'asset', { etag: 'etag', valid: true, media: { width: 160, height: 90, durationSeconds: 12 } });
    assert.equal(h.db.prepare('SELECT status FROM media_assets').get().status, 'superseded');
    assert.equal(h.db.prepare('SELECT video_status FROM episodes').get().video_status, 'waiting_upload');
  } finally { h.db.close(); }
});

test('R2 playback retains login, free/paid entitlement and device-limit checks before minting a URL', async () => {
  const h = harness();
  try {
    await complete(h); publish(h);
    await assert.rejects(h.playback(event({ loggedOut: true })), error => error.statusCode === 401);
    await assert.rejects(h.playback(event({ deviceBlocked: true })), error => error.statusCode === 429);
    assert.equal(h.calls(), 1);
    const freeEvent = event();
    const free = (await h.playback(freeEvent)).data;
    assert.equal(free.delivery, 'mp4');
    assert.equal(free.signedUrl, free.originalUrl);
    assert.equal(freeEvent.headers['cache-control'], 'no-store');
    h.db.exec('UPDATE episodes SET is_free = 0');
    await assert.rejects(h.playback(event()), error => error.statusCode === 403);
    assert.equal(h.calls(), 2);
    h.db.exec("INSERT INTO manual_entitlements (id, user_id, series_id, series_title, status, reason, granted_by, granted_at) VALUES ('grant', 'user', 'series', 'Series', 'granted', 'Test', 'admin', 'now')");
    assert.equal((await h.playback(event())).data.authorized, true);
    h.db.exec("UPDATE manual_entitlements SET status = 'revoked'");
    await assert.rejects(h.playback(event()), error => error.statusCode === 403);
  } finally { h.db.close(); }
});

test('acceptance seeding creates draft metadata without Stream requests or pretend playable assets', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    const directory = new URL('../migrations/', import.meta.url);
    for (const file of readdirSync(directory).filter(name => name.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(file, directory), 'utf8'));
    const source = readFileSync(new URL('../scripts/seed-acceptance-data.mjs', import.meta.url), 'utf8')
      .replace("import { readFileSync } from 'node:fs';", '');
    const run = () => runInNewContext(`(async () => { ${source}\n })()`, {
      process: { env: { CLOUDFLARE_ACCOUNT_ID: 'account', CLOUDFLARE_D1_DATABASE_ID: 'database', CLOUDFLARE_API_TOKEN: 'test' }, argv: [] },
      readFileSync: () => '', console: { log: () => {} },
      fetch: async (url, options) => {
        assert.ok(url.endsWith('/d1/database/database/query'));
        const { sql, params } = JSON.parse(options.body);
        const results = db.prepare(sql).all(...params);
        return { ok: true, json: async () => ({ success: true, result: [{ success: true, results }] }) };
      },
    });
    await run(); await run();
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM series').get().count, 5);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM series WHERE status = 'draft'").get().count, 5);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM episodes').get().count, 7);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM episodes WHERE video_status = 'ready'").get().count, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM media_assets').get().count, 0);
  } finally { db.close(); }
});

test('playback API passes through HLS delivery and startup URLs without treating the manifest as original MP4', async () => {
  const h = harness();
  try {
    await complete(h); publish(h);
    h.setWorkerPlayback({ url: 'https://media.test/hls/token/master.m3u8', delivery: 'hls',
      prefetchUrls: ['https://media.test/hls/token/v360/seg-000000.m4s'] });
    const response = (await h.playback(event())).data;
    assert.equal(response.delivery, 'hls');
    assert.equal(response.originalUrl, undefined);
    assert.match(response.signedUrl, /master.m3u8$/);
    assert.equal(response.prefetchUrls.length, 1);
    h.db.exec('UPDATE episodes SET is_free = 0');
    await assert.rejects(h.playback(event({ query: { seriesId: 'series', episodeNo: 1, sessionId: 'next', prewarm: 'true' } })), error => error.statusCode === 403);
  } finally { h.db.close(); }
});

test('playback API returns validated Cloudflare Stream HLS without minting an R2 URL', async () => {
  const h = harness();
  try {
    await complete(h); publish(h);
    const uid = '0123456789abcdef0123456789abcdef';
    h.db.prepare(`UPDATE media_assets SET storage_provider = 'stream', stream_uid = ?, hls_url = ?, source_object_key = ? WHERE id = 'asset'`)
      .run(uid, `https://customer-example.cloudflarestream.com/${uid}/manifest/video.m3u8`, 'https://example.test/source.webm');
    const response = (await h.playback(event())).data;
    assert.equal(response.delivery, 'hls');
    assert.equal(response.signedUrl, 'https://customer-example.cloudflarestream.com/signed-stream-token-1234567890/manifest/video.m3u8');
    assert.equal(response.originalUrl, undefined);
    assert.equal(h.calls(), 1);

    h.db.prepare("UPDATE media_assets SET hls_url = 'https://attacker.test/video.m3u8' WHERE id = 'asset'").run();
    await assert.rejects(h.playback(event()), error => error.statusCode === 503);
  } finally { h.db.close(); }
});
