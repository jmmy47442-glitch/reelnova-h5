import { readFileSync } from 'node:fs';
import { inspectDirectMp4, inspectStoredMp4, MP4_PROBE_BYTES } from '../shared/direct-mp4.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import worker from '../workers/media-worker.mjs';
import { createBucket } from './helpers/media-bucket.mjs';

const fixture = (name = 'compatible') => new Uint8Array(readFileSync(new URL(`./fixtures/media/${name}.mp4`, import.meta.url)));
const encoder = new TextEncoder();
const secret = 'test-media-worker-secret';

const sign = async (rawBody) => {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(`${timestamp}.${rawBody}`)));
  return { timestamp, signature: Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('') };
};

const signedRequest = async (path, body, method = 'POST') => {
  const rawBody = JSON.stringify(body);
  const { timestamp, signature } = await sign(rawBody);
  return new Request(`https://media.example.test${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-reelnova-timestamp': timestamp, 'x-reelnova-signature': signature },
    body: rawBody,
  });
};


test('moov-at-end originals pass playback and upload validation', async () => {
  const bucket = createBucket();
  const assetId = 'media_11111111-1111-4111-8111-111111111111';
  const key = `originals/series_1/episode_1/${assetId}/legacy.mp4`;
  const bytes = fixture('no-faststart');
  await bucket.put(key, bytes, { httpMetadata: { contentType: 'video/mp4' }, customMetadata: { assetId } });
  // R2 exposes a quoted HTTP ETag and an unquoted conditional-request ETag.
  const head = bucket.head.bind(bucket);
  bucket.head = async objectKey => { const object = await head(objectKey); return object ? { ...object, httpEtag: `"${object.etag}"` } : null; };
  const env = { MEDIA_BUCKET: bucket, MEDIA_WORKER_SECRET: secret };
  for (let attempt = 0; attempt < 2; attempt++) {
    const grant = await worker.fetch(await signedRequest('/original/token', { key, assetId }), env);
    assert.equal(grant.status, 200);
    const response = await worker.fetch(new Request((await grant.json()).url, { headers: { range: 'bytes=-1024' } }), env);
    assert.equal(response.status, 206);
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes.slice(-1024));
  }
  const upload = await worker.fetch(await signedRequest('/videos/verify', { objectKey: key, assetId }), env);
  assert.equal((await upload.json()).valid, true);
});

test('stored MP4 inspection skips a large mdat to validate tail metadata with bounded reads', async () => {
  const bytes = fixture('no-faststart');
  let position = 0;
  let mdatOffset, moovOffset;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  while (position < bytes.length) {
    const type = new TextDecoder().decode(bytes.slice(position + 4, position + 8));
    if (type === 'mdat') mdatOffset = position;
    if (type === 'moov') moovOffset = position;
    position += view.getUint32(position);
  }
  const gap = 200 * 1024 * 1024;
  const prefix = bytes.slice(0, moovOffset);
  new DataView(prefix.buffer).setUint32(mdatOffset, view.getUint32(mdatOffset) + gap);
  const tailOffset = moovOffset + gap;
  const size = bytes.length + gap;
  const reads = [];
  const result = await inspectStoredMp4(size, async (offset, length) => {
    reads.push({ offset, length });
    const buffer = new Uint8Array(length);
    if (offset === 0) buffer.set(prefix);
    else { assert.equal(offset, tailOffset); buffer.set(bytes.slice(moovOffset)); }
    return buffer.buffer;
  });
  assert.equal(result.hasVideo, true);
  assert.equal(result.hasAudio, true);
  assert.equal(reads.length, 2);
  assert.ok(reads.reduce((total, read) => total + read.length, 0) < 1024 * 1024);
});

test('stored MP4 inspection still rejects unsupported codecs and truncated metadata', async () => {
  for (const bytes of [fixture('unsupported-video'), fixture('no-faststart').slice(0, 4991)]) {
    await assert.rejects(inspectStoredMp4(bytes.length, async (offset, length) => bytes.slice(offset, offset + length).buffer));
  }
  // An oversized incomplete moov cannot force an unlimited download.
  let total = 0, calls = 0;
  await assert.rejects(inspectStoredMp4(64 * 1024 * 1024, async (offset, length) => {
    calls++; total += length;
    const bytes = new Uint8Array(length);
    if (offset === 0) { new DataView(bytes.buffer).setUint32(0, 64 * 1024 * 1024); bytes.set(encoder.encode('moov'), 4); }
    return bytes.buffer;
  }), /16 MB/);
  assert.ok(calls <= 32);
  assert.ok(total <= MP4_PROBE_BYTES);
});

test('original playback tokens stream private source bytes with range support', async () => {
  const bucket = createBucket();
  const assetId = 'media_11111111-1111-4111-8111-111111111111';
  const objectKey = `originals/series_1/episode_1/${assetId}/1-source.mp4`;
  const source = fixture();
  await bucket.put(objectKey, source, {
    httpMetadata: { contentType: 'video/mp4' },
    customMetadata: { managedBy: 'reelnova', assetId },
  });
  const env = {
    MEDIA_BUCKET: bucket,
    MEDIA_WORKER_SECRET: secret,
    APP_ORIGINS: 'https://app.example.test',
  };
  const grantResponse = await worker.fetch(await signedRequest('/original/token', {
    key: objectKey,
    assetId,
    exp: Math.floor(Date.now() / 1000) + 600,
  }), env);
  assert.equal(grantResponse.status, 200);
  const grant = await grantResponse.json();

  const response = await worker.fetch(new Request(grant.url, {
    headers: { origin: 'https://app.example.test', range: 'bytes=2-5' },
  }), env);
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-type'), 'video/mp4');
  assert.equal(response.headers.get('content-range'), `bytes 2-5/${fixture().length}`);
  assert.equal(response.headers.get('access-control-allow-origin'), 'https://app.example.test');
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), fixture().slice(2, 6));
});

test('cancelling an upload aborts multipart state and removes its resume marker', async () => {
  const bucket = createBucket();
  const env = {
    MEDIA_BUCKET: bucket,
    MEDIA_WORKER_SECRET: secret,
    CLOUDFLARE_ACCOUNT_ID: 'account-id',
    CLOUDFLARE_API_TOKEN: 'api-token',
    PUBLIC_BASE_URL: 'https://media.example.test',
    APP_ORIGINS: '',
  };
  const creation = {
    idempotencyKey: 'upload:33333333-3333-4333-8333-333333333333',
    sessionId: 'upload_session_cancel',
    completionKey: 'r2:upload_session_cancel',
    streamIdempotencyKey: 'reelnova:upload:upload_session_cancel',
    objectKey: 'originals/series/episode/asset/cancel.mp4',
    contentType: 'video/mp4',
    fileSizeBytes: 1024,
    metadata: { assetId: 'asset_cancel' },
  };
  const upload = await (await worker.fetch(await signedRequest('/uploads', creation), env)).json();
  const cancellation = {
    uploadId: upload.uploadId,
    sessionId: creation.sessionId,
    objectKey: creation.objectKey,
    idempotencyKey: creation.idempotencyKey,
  };
  const response = await worker.fetch(await signedRequest(`/uploads/${upload.uploadId}`, cancellation, 'DELETE'), env);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { uploadId: upload.uploadId, sessionId: creation.sessionId, status: 'aborted' });
  assert.equal(bucket.abortCount, 1);

  const restarted = await (await worker.fetch(await signedRequest('/uploads', creation), env)).json();
  assert.notEqual(restarted.uploadId, upload.uploadId);
  assert.equal(bucket.createCount, 2);
});

test('MP4 completion is idempotent and works without Stream credentials or network calls', async () => {
  const bucket = createBucket();
  const env = { MEDIA_BUCKET: bucket, MEDIA_WORKER_SECRET: secret };
  const bytes = fixture();
  const creation = {
    idempotencyKey: 'upload:11111111-1111-4111-8111-111111111111',
    sessionId: 'upload_session_1', completionKey: 'r2:upload_session_1',
    objectKey: 'originals/series/episode/asset/video.mp4', contentType: 'video/mp4', fileSizeBytes: bytes.length,
    metadata: { assetId: 'asset_1' },
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('Unexpected external request'); };
  try {
    const first = await (await worker.fetch(await signedRequest('/uploads', creation), env)).json();
    const second = await (await worker.fetch(await signedRequest('/uploads', creation), env)).json();
    assert.equal(first.uploadId, second.uploadId);
    assert.equal(bucket.createCount, 1);
    const part = await worker.fetch(new Request(`${first.uploadUrl}/parts/1`, {
      method: 'PUT', headers: { authorization: `Bearer ${first.uploadToken}` }, body: bytes,
    }), env);
    assert.equal(part.status, 200);
    const completion = { ...creation, uploadId: first.uploadId, parts: [await part.json()] };
    const one = await worker.fetch(await signedRequest(`/uploads/${first.uploadId}/complete`, completion), env);
    const two = await worker.fetch(await signedRequest(`/uploads/${first.uploadId}/complete`, completion), env);
    assert.equal(one.status, 200);
    const result = await one.json();
    assert.equal(result.valid, true);
    assert.equal(result.media.width, 160);
    assert.deepEqual(await two.json(), result);
    const mismatch = await worker.fetch(await signedRequest(`/uploads/${first.uploadId}/complete`, { ...completion, fileSizeBytes: 1 }), env);
    assert.equal(mismatch.status, 500);
    const foreign = await worker.fetch(await signedRequest(`/uploads/${first.uploadId}/complete`, { ...completion, sessionId: 'foreign' }), env);
    assert.equal(foreign.status, 500);
    const cleanup = await worker.fetch(await signedRequest('/reconcile', { keepObjectKeys: [creation.objectKey] }), env);
    assert.equal(cleanup.status, 200);
    assert.deepEqual((await cleanup.json()).errors, []);
  } finally { globalThis.fetch = originalFetch; }
});

test('private ingest supports metadata probes and byte ranges', async () => {
  const bucket = createBucket();
  const env = {
    MEDIA_BUCKET: bucket,
    MEDIA_WORKER_SECRET: secret,
    CLOUDFLARE_ACCOUNT_ID: 'account-id',
    CLOUDFLARE_API_TOKEN: 'api-token',
    PUBLIC_BASE_URL: 'https://media.example.test',
    APP_ORIGINS: '',
  };
  const creation = {
    idempotencyKey: 'upload:22222222-2222-4222-8222-222222222222',
    sessionId: 'upload_session_ingest',
    completionKey: 'r2:upload_session_ingest',
    streamIdempotencyKey: 'reelnova:upload:upload_session_ingest',
    objectKey: 'originals/series/episode/asset/ingest.mp4',
    contentType: 'video/mp4',
    fileSizeBytes: 10,
    metadata: { assetId: 'asset_ingest' },
  };
  const upload = await (await worker.fetch(await signedRequest('/uploads', creation), env)).json();
  await bucket.put(creation.objectKey, Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]), {
    httpMetadata: { contentType: 'video/mp4' },
  });
  const url = `https://media.example.test/ingest/${encodeURIComponent(upload.uploadToken)}`;

  const head = await worker.fetch(new Request(url, { method: 'HEAD' }), env);
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-type'), 'video/mp4');
  assert.equal(head.headers.get('content-length'), '10');
  assert.equal(head.headers.get('accept-ranges'), 'bytes');

  const partial = await worker.fetch(new Request(url, { headers: { range: 'bytes=2-5' } }), env);
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get('content-range'), 'bytes 2-5/10');
  assert.equal(partial.headers.get('content-length'), '4');
  assert.deepEqual([...new Uint8Array(await partial.arrayBuffer())], [2, 3, 4, 5]);

  const invalid = await worker.fetch(new Request(url, { headers: { range: 'bytes=20-30' } }), env);
  assert.equal(invalid.status, 416);
  assert.equal(invalid.headers.get('content-range'), 'bytes */10');
});

test('series cover uploads require a signed grant and become immutable public images', async () => {
  const bucket = createBucket();
  const env = {
    MEDIA_BUCKET: bucket,
    MEDIA_WORKER_SECRET: secret,
    PUBLIC_BASE_URL: 'https://media.example.test',
    APP_ORIGINS: 'https://admin.example.test',
  };
  const imageBytes = Uint8Array.from([255, 216, 255, 224, 1, 2, 3, 4]);
  const creation = {
    objectKey: 'posters/sr-cover-test/cover-11111111-1111-4111-8111-111111111111.jpg',
    seriesId: 'sr-cover-test',
    contentType: 'image/jpeg',
    fileSizeBytes: imageBytes.byteLength,
  };
  const createdResponse = await worker.fetch(await signedRequest('/images/uploads', creation), env);
  assert.equal(createdResponse.status, 200);
  const created = await createdResponse.json();
  assert.equal(created.uploadUrl, 'https://media.example.test/images/upload');

  const forged = await worker.fetch(new Request(created.uploadUrl, {
    method: 'PUT',
    headers: { 'content-type': 'image/jpeg', 'content-length': String(imageBytes.byteLength) },
    body: imageBytes,
  }), env);
  assert.equal(forged.status, 401);

  const disguisedFile = await worker.fetch(new Request(created.uploadUrl, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${created.uploadToken}`,
      'content-type': 'image/jpeg',
      'content-length': String(imageBytes.byteLength),
    },
    body: Uint8Array.from({ length: imageBytes.byteLength }, () => 65),
  }), env);
  assert.equal(disguisedFile.status, 415);

  const uploaded = await worker.fetch(new Request(created.uploadUrl, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${created.uploadToken}`,
      'content-type': 'image/jpeg',
      'content-length': String(imageBytes.byteLength),
      origin: 'https://admin.example.test',
    },
    body: imageBytes,
  }), env);
  assert.equal(uploaded.status, 200);
  assert.equal(uploaded.headers.get('access-control-allow-origin'), 'https://admin.example.test');

  const verification = await worker.fetch(await signedRequest('/images/verify', {
    objectKey: creation.objectKey,
    seriesId: creation.seriesId,
  }), env);
  assert.equal(verification.status, 200);
  assert.deepEqual(await verification.json(), {
    objectKey: creation.objectKey,
    publicUrl: `https://media.example.test/${creation.objectKey}`,
    contentType: 'image/jpeg',
    size: imageBytes.byteLength,
  });

  const publicImage = await worker.fetch(new Request(`https://media.example.test/${creation.objectKey}`), env);
  assert.equal(publicImage.status, 200);
  assert.equal(publicImage.headers.get('content-type'), 'image/jpeg');
  assert.equal(publicImage.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.deepEqual([...new Uint8Array(await publicImage.arrayBuffer())], [...imageBytes]);
});

test('unsupported direct-play formats are routed to container transcoding', async () => {
  const bucket = createBucket();
  const env = { MEDIA_BUCKET: bucket, MEDIA_WORKER_SECRET: secret, MEDIA_TRANSCODE_ENABLED: 'true' };
  for (const name of ['unsupported-video']) {
    const key = `originals/series/episode/asset/${name}.mp4`;
    await bucket.put(key, fixture(name), { httpMetadata: { contentType: 'video/mp4' }, customMetadata: { assetId: 'asset' } });
    const response = await worker.fetch(await signedRequest('/videos/verify', { objectKey: key, assetId: 'asset' }), env);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.valid, false);
    assert.equal(result.status, 'processing');
    assert.equal(result.transcodeRequired, true);
    assert.equal(result.sourceEtag, `etag:${key}`);
  }
  assert.throws(() => inspectDirectMp4(new ArrayBuffer(32)), /MP4/);
});

test('private playback rejects expired and tampered tokens and supports HEAD and ranges', async () => {
  const bucket = createBucket();
  const env = { MEDIA_BUCKET: bucket, MEDIA_WORKER_SECRET: secret };
  const assetId = 'media_11111111-1111-4111-8111-111111111111';
  const key = `originals/series_1/episode_1/${assetId}/1-video.mp4`;
  const bytes = fixture();
  await bucket.put(key, bytes, { httpMetadata: { contentType: 'video/mp4' }, customMetadata: { assetId } });
  const minted = await worker.fetch(await signedRequest('/original/token', { key, assetId }), env);
  assert.equal(minted.status, 200);
  const { url } = await minted.json();
  const head = await worker.fetch(new Request(url, { method: 'HEAD' }), env);
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), String(bytes.length));
  assert.equal(head.headers.get('cache-control'), 'private, no-store');
  const suffix = await worker.fetch(new Request(url, { headers: { range: 'bytes=-4' } }), env);
  assert.equal(suffix.status, 206);
  assert.deepEqual(new Uint8Array(await suffix.arrayBuffer()), bytes.slice(-4));
  const invalid = await worker.fetch(new Request(url, { headers: { range: 'bytes=999999-' } }), env);
  assert.equal(invalid.status, 416);
  assert.equal((await worker.fetch(new Request(`${url}x`), env)).status, 403);
  const realNow = Date.now;
  Date.now = () => realNow() + 20 * 60 * 1000;
  try { assert.equal((await worker.fetch(new Request(url), env)).status, 403); }
  finally { Date.now = realNow; }
  const unsigned = new Request('https://media.example.test/original/token', { method: 'POST', body: JSON.stringify({ key, assetId }) });
  assert.equal((await worker.fetch(unsigned, env)).status, 401);
  assert.equal((await worker.fetch(new Request(`https://media.example.test/${key}`), env)).status, 404);
});

test('health checks verify the private R2 binding with server authentication', async () => {
  const env = { MEDIA_BUCKET: createBucket(), MEDIA_WORKER_SECRET: secret, MEDIA_TRANSCODE_ENABLED: 'true',
    TRANSCODE_SERVICE: { fetch: async () => Response.json({ ready: true, engine: 'cloudflare-containers-ffmpeg' }) } };
  const response = await worker.fetch(await signedRequest('/health', {}), env);
  assert.deepEqual(await response.json(), { ready: true, delivery: 'r2-hls', transcodingEnabled: true, transcoderReady: true });
  const unsigned = new Request('https://media.example.test/health', { method: 'POST', body: '{}' });
  assert.equal((await worker.fetch(unsigned, env)).status, 401);
  assert.equal((await worker.fetch(await signedRequest('/stream/token', {}), env)).status, 404);
});

test('signed transcode requests are forwarded only through the private service binding', async () => {
  let forwarded;
  const env = { MEDIA_BUCKET: createBucket(), MEDIA_WORKER_SECRET: secret, MEDIA_TRANSCODE_ENABLED: 'true',
    TRANSCODE_SERVICE: { fetch: async (request) => {
      forwarded = { url: request.url, body: await request.json() };
      return Response.json({ jobId: forwarded.body.jobId, workflowId: forwarded.body.jobId });
    } } };
  const body = { jobId: 'transcode_media_11111111-1111-4111-8111-111111111111' };
  const response = await worker.fetch(await signedRequest('/transcodes', body), env);
  assert.equal(response.status, 200);
  assert.equal(forwarded.url, 'https://transcoder.internal/jobs');
  assert.deepEqual(forwarded.body, body);
  assert.equal((await worker.fetch(new Request('https://media.example.test/transcodes', { method: 'POST', body: '{}' }), env)).status, 401);
});

test('MP4 upload health and validation do not depend on a paid container', async () => {
  const env = { MEDIA_BUCKET: createBucket(), MEDIA_WORKER_SECRET: secret,
    TRANSCODE_SERVICE: { fetch: () => assert.fail('Free mode must never call the container') } };
  const health = await worker.fetch(await signedRequest('/health', {}), env);
  assert.deepEqual(await health.json(), { ready: true, delivery: 'r2-mp4', transcodingEnabled: false, transcoderReady: false });
  const rejected = await worker.fetch(await signedRequest('/transcodes', {}), env);
  assert.equal(rejected.status, 409);
});

test('mobile selection uses only the matching original version and falls back when missing or invalid', async () => {
  const bucket = createBucket();
  const assetId = 'media_11111111-1111-4111-8111-111111111111';
  const key = `originals/series_1/episode_1/${assetId}/source.mp4`;
  const source = new Uint8Array(fixture().length + 4096);
  source.set(fixture());
  new DataView(source.buffer).setUint32(fixture().length, 4096);
  source.set(encoder.encode('free'), fixture().length + 4);
  await bucket.put(key, source, { httpMetadata: { contentType: 'video/mp4' }, customMetadata: { assetId } });
  const env = { MEDIA_BUCKET: bucket, MEDIA_WORKER_SECRET: secret };
  const mint = async () => {
    const response = await worker.fetch(await signedRequest('/original/token', { key, assetId, profile: 'mobile' }), env);
    assert.equal(response.status, 200);
    return response.json();
  };
  assert.equal((await mint()).rendition, 'original');
  const variant = `variants/${assetId}/${encodeURIComponent((await bucket.head(key)).etag)}/mobile.mp4`;
  await bucket.put(variant.replace('/mobile.mp4', '/other.mp4'), fixture(), { httpMetadata: { contentType: 'video/mp4' } });
  assert.equal((await mint()).rendition, 'original', 'an arbitrary rendition is not selectable');
  await bucket.put(variant, fixture('unsupported-video'), { httpMetadata: { contentType: 'video/mp4' } });
  assert.equal((await mint()).rendition, 'original');
  await bucket.put(variant, fixture(), { httpMetadata: { contentType: 'video/mp4' } });
  const grant = await mint();
  assert.equal(grant.rendition, 'mobile');
  const response = await worker.fetch(new Request(grant.url), env);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), fixture());
});
