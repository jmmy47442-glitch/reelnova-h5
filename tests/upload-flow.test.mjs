import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { uploadFlow, videoFixture } from './helpers/upload-flow.mjs';

const pending = async (h, file, episodeNo = 1) => {
  const idempotencyKey = `upload:${crypto.randomUUID()}`;
  const session = await h.api.createEpisodeUpload('series-test', {
    idempotencyKey, episodeNo, title: `Episode ${episodeNo}`, fileName: file.name,
    contentType: file.type, fileSizeBytes: file.size,
  });
  const key = h.client.resumeKey('series-test', episodeNo, file);
  h.storage.set(key, JSON.stringify({ session, parts: [] }));
  h.storage.set(`${key}:idempotency`, idempotencyKey);
  return { session, key };
};

test('real uploader creates a session, uploads MP4, completes SQL state and previews the same bytes', async () => {
  const h = uploadFlow();
  try {
    const file = videoFixture();
    assert.equal(await h.upload(file), 'ready');
    assert.equal(h.storage.size, 0);
    const asset = h.db.prepare('SELECT id, status FROM media_assets').get();
    assert.equal(asset.status, 'ready');
    assert.equal(h.db.prepare('SELECT status FROM media_upload_sessions').get().status, 'completed');
    const response = await h.fetchMedia(await h.preview(asset.id));
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from(await file.arrayBuffer()));
  } finally { h.db.close(); }
});

test('cancel, delete, then upload the same episode with stale browser storage uses a new session', async () => {
  const h = uploadFlow();
  try {
    const file = videoFixture();
    const { session } = await pending(h, file, 4);
    await h.api.cancelEpisodeUpload(session.id);
    await h.managed.deleteManagedEpisodeRecord({}, 'series-test', session.episodeId);
    assert.equal(await h.upload(file, 4), 'ready');
    assert.equal(h.bucket.createCount, 2);
    assert.equal(h.storage.size, 0);
    assert.equal(h.db.prepare('SELECT status FROM media_upload_sessions WHERE id = ?').get(session.id).status, 'aborted');
    const current = h.db.prepare('SELECT episode_no, video_status FROM episodes WHERE deleted_at IS NULL').get();
    assert.equal(current.episode_no, 4); assert.equal(current.video_status, 'ready');
  } finally { h.db.close(); }
});

test('expired server sessions are replaced; expired browser tokens renew the active multipart', async () => {
  for (const terminal of [true, false]) {
    const h = uploadFlow();
    try {
      const file = videoFixture(); const { session, key } = await pending(h, file);
      const saved = JSON.parse(h.storage.get(key)); saved.session.expiresAt = '2000-01-01';
      h.storage.set(key, JSON.stringify(saved));
      if (terminal) h.db.exec("UPDATE media_upload_sessions SET status = 'expired'; UPDATE media_assets SET status = 'failed'; UPDATE episodes SET video_status = 'failed'");
      assert.equal(await h.upload(file), 'ready');
      assert.equal(h.bucket.createCount, terminal ? 2 : 1);
      assert.equal((await h.api.getEpisodeUpload(session.id)).status, terminal ? 'expired' : 'completed');
    } finally { h.db.close(); }
  }
});

test('part network errors retry, and a lost finalize response recovers without uploading twice', async () => {
  const h = uploadFlow();
  try {
    h.faults.failPart = 1; h.faults.loseCompletion = true;
    assert.equal(await h.upload(videoFixture()), 'ready');
    assert.equal(h.bucket.createCount, 1);
    assert.equal(h.log.filter(p => /\/parts\/1$/.test(p)).length, 2);
    assert.ok(h.log.includes('/videos/verify'));
  } finally { h.db.close(); }
});

test('a completed upload with stale local storage does not send parts or create another asset', async () => {
  const h = uploadFlow();
  try {
    const file = videoFixture(); const { key } = await pending(h, file);
    const saved = new Map(h.storage);
    assert.equal(await h.upload(file), 'ready');
    for (const [k, v] of saved) h.storage.set(k, v);
    const expired = JSON.parse(h.storage.get(key)); expired.session.expiresAt = '2000-01-01';
    h.storage.set(key, JSON.stringify(expired));
    const partCount = h.log.filter(p => p.includes('/parts/')).length;
    assert.equal(await h.upload(file), 'ready');
    assert.equal(h.bucket.createCount, 1);
    assert.equal(h.log.filter(p => p.includes('/parts/')).length, partCount);
  } finally { h.db.close(); }
});

test('status lookup failure preserves resume state and never creates a replacement upload', async () => {
  const h = uploadFlow();
  try {
    const file = videoFixture(); const { key } = await pending(h, file);
    h.faults.stateError = Object.assign(new Error('Unavailable'), { statusCode: 502 });
    await assert.rejects(h.upload(file), /Unavailable/);
    assert.ok(h.storage.has(key)); assert.equal(h.bucket.createCount, 1);
  } finally { h.db.close(); }
});

test('cancellation during completion is disabled and automatic recovery cannot loop forever', async () => {
  const h = uploadFlow();
  try {
    h.faults.beforeComplete = async id => {
      h.client.cancelUpload(); assert.equal(h.refs.uploadCancelled.value, null);
      // Simulate another tab cancelling this session, which cannot be blocked
      // by the current tab's disabled button.
      await h.api.cancelEpisodeUpload(id);
    };
    await assert.rejects(h.upload(videoFixture()), /再次被取消或过期/);
    assert.equal(h.bucket.createCount, 2);
    assert.equal(h.storage.size, 0);
    assert.equal(h.refs.uploadFinalizing.value, false);
  } finally { h.db.close(); }
});

test('existing HLS assets still support signed callbacks and preview in MP4 upload mode', async () => {
  const h = uploadFlow();
  try {
    assert.equal(await h.upload(videoFixture()), 'ready');
    const asset = h.db.prepare('SELECT id, source_etag, source_object_key, episode_id FROM media_assets').get();
    h.env.MEDIA_TRANSCODE_ENABLED = 'true';
    await h.state.queueMediaTranscode({}, { media_asset_id: asset.id, object_key: asset.source_object_key, episode_id: asset.episode_id }, { sourceEtag: asset.source_etag }, true);
    h.env.MEDIA_TRANSCODE_ENABLED = 'false';
    const body = { jobId: `transcode_${asset.id}`, assetId: asset.id, status: 'ready', sourceEtag: asset.source_etag,
      hlsPrefix: `hls/${asset.id}/${asset.source_etag}/build/`, renditions: [{ id: 'v360' }],
      media: { width: 160, height: 90, durationSeconds: 12, hasVideo: true, hasAudio: true } };
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac('sha256', h.env.MEDIA_WORKER_SECRET).update(`${timestamp}.${JSON.stringify(body)}`).digest('hex');
    await h.callback({ body, headers: { 'x-reelnova-timestamp': timestamp, 'x-reelnova-signature': signature } });
    assert.equal(h.db.prepare('SELECT video_status FROM episodes').get().video_status, 'ready');
    assert.equal(h.db.prepare('SELECT progress FROM transcode_jobs').get().progress, 100);
    const buildId = crypto.randomUUID();
    const root = `hls/${asset.id}/${asset.source_etag}`;
    await h.bucket.put(`${root}/ready.json`, JSON.stringify({ version: 1, assetId: asset.id,
      sourceEtag: asset.source_etag, buildId, renditions: [{ id: 'v360', segments: 1 }] }));
    await h.bucket.put(`${root}/${buildId}/master.m3u8`, '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=600000\nv360/index.m3u8\n');
    const { data: grant } = await h.preview(asset.id, { format: 'json' });
    assert.equal(grant.delivery, 'hls');
    const preview = await h.fetchMedia(grant.url);
    assert.equal(preview.status, 200);
    assert.match(await preview.text(), /v360\/index.m3u8/);
  } finally { h.db.close(); }
});

test('free mode rejects unsupported files before upload and verifies bytes even when preflight is bypassed', async () => {
  const h = uploadFlow();
  try {
    const file = videoFixture('unsupported-video');
    await assert.rejects(h.upload(file), /本地转换/);
    assert.equal(h.bucket.createCount, 0);
    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM episodes').get().n, 0);
    await assert.rejects(h.api.createEpisodeUpload('series-test', { idempotencyKey: `upload:${crypto.randomUUID()}`, episodeNo: 1,
      fileName: 'video.mov', contentType: 'video/quicktime', fileSizeBytes: file.size }), /Only H.264/);
    const { session } = await pending(h, file);
    const partResponse = await h.transport(new Request(`${session.uploadUrl}/parts/1`, {
      method: 'PUT', headers: { Authorization: `Bearer ${session.uploadToken}` }, body: await file.arrayBuffer(),
    }));
    assert.equal(partResponse.status, 200);
    const result = await h.api.completeEpisodeUpload(session.id, [await partResponse.json()]);
    assert.equal(result.status, 'failed');
    assert.match(result.errorMessage, /本地转换/);
    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM transcode_jobs').get().n, 0);
    assert.equal(h.log.includes('/transcodes'), false);
    assert.equal((await h.api.retryTranscode(session.mediaAssetId)).status, 'failed');
  } finally { h.db.close(); }
});

test('a late Worker response cannot resurrect a session cancelled while finalize was running', async () => {
  const h = uploadFlow();
  try {
    const file = videoFixture(); const { session } = await pending(h, file);
    const cancelAfterFinalize = async () => {
      await h.api.cancelEpisodeUpload(session.id);
      h.faults.afterFinalize = null;
    };
    h.faults.afterFinalize = cancelAfterFinalize;
    // Prevent automatic client recovery so the terminal state is observable.
    h.refs.uploadCancelled.value = false;
    h.faults.beforeComplete = async () => { h.refs.uploadCancelled.value = true; };
    await assert.rejects(h.upload(file), error => error.statusCode === 409 && error.data.uploadStatus === 'aborted');
    assert.equal((await h.api.getEpisodeUpload(session.id)).status, 'aborted');
    assert.equal(h.db.prepare('SELECT status FROM media_assets').get().status, 'superseded');
    assert.equal(h.db.prepare('SELECT video_status FROM episodes').get().video_status, 'waiting_upload');
  } finally { h.db.close(); }
});
