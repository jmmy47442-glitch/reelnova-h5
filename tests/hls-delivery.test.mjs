import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import worker from '../workers/media-worker.mjs';

const secret = 'hls-test-secret', assetId = 'media_11111111-1111-4111-8111-111111111111';
const sourceKey = `originals/series_1/episode_1/${assetId}/source.mp4`;
const buildId = '22222222-2222-4222-8222-222222222222';
const root = `hls/${assetId}/original-etag`, prefix = `${root}/${buildId}/`;
const marker = { version: 1, assetId, sourceEtag: 'original-etag', buildId,
  renditions: [{ id: 'v360', segments: 2 }, { id: 'v720', segments: 2 }] };
const signRequest = async body => {
  const raw = JSON.stringify(body), timestamp = String(Math.floor(Date.now() / 1000));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = Buffer.from(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${raw}`))).toString('hex');
  return new Request('https://media.test/original/token', { method: 'POST', body: raw,
    headers: { 'x-reelnova-timestamp': timestamp, 'x-reelnova-signature': signature } });
};
const harness = t => {
  const objects = new Map(), entries = new Map(), jobs = [];
  let reads = 0;
  const put = (key, body, options = {}) => {
    const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body;
    objects.set(key, { bytes, size: bytes.length, etag: key === sourceKey ? 'original-etag' : key,
      httpEtag: `"${key}"`, customMetadata: options.customMetadata || {}, httpMetadata: options.httpMetadata || {} });
  };
  const object = (key, range) => {
    const value = objects.get(key);
    if (!value) return null;
    const bytes = range ? value.bytes.slice(range.offset, range.offset + range.length) : value.bytes;
    return { ...value, body: bytes, arrayBuffer: async () => bytes.slice().buffer,
      json: async () => JSON.parse(new TextDecoder().decode(bytes)),
      writeHttpMetadata: headers => headers.set('content-type', value.httpMetadata.contentType || 'video/mp4') };
  };
  put(sourceKey, new Uint8Array(readFileSync(new URL('./fixtures/media/compatible.mp4', import.meta.url))),
    { customMetadata: { assetId }, httpMetadata: { contentType: 'video/mp4' } });
  put(`${root}/ready.json`, JSON.stringify(marker));
  put(`${prefix}master.m3u8`, '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=600000\nv360/index.m3u8\n');
  put(`${prefix}v360/index.m3u8`, '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:2,\nseg-000000.m4s\n#EXT-X-ENDLIST\n');
  put(`${prefix}v360/init.mp4`, new Uint8Array([0, 1, 2, 3]));
  put(`${prefix}v360/seg-000000.m4s`, new Uint8Array([4, 5, 6, 7]));
  const env = { MEDIA_WORKER_SECRET: secret, APP_ORIGINS: 'https://a.test,https://b.test', MEDIA_BUCKET: {
    head: async key => object(key), get: async (key, options) => { reads++; return object(key, options?.range); }, put: async (...args) => put(...args),
  } };
  const previous = globalThis.caches;
  globalThis.caches = { default: {
    match: async key => entries.get(key.url)?.clone(),
    put: async (key, response) => { assert.equal(response.status, 200); entries.set(key.url, new Response(await response.arrayBuffer(), response)); },
  } };
  t.after(() => { globalThis.caches = previous; });
  const ctx = { waitUntil: job => jobs.push(job) };
  const drain = async () => { while (jobs.length) await Promise.all(jobs.splice(0)); };
  const grant = async (extra = {}) => (await worker.fetch(await signRequest({ key: sourceKey, assetId, delivery: 'auto', ...extra }), env, ctx)).json();
  const get = (url, extra = {}) => worker.fetch(new Request(url, extra), env, ctx);
  return { env, entries, objects, put, grant, get, drain, reads: () => reads };
};

test('published HLS is selected, serves independent relative playlists and caches authorized segments', async t => {
  const h = harness(t), grant = await h.grant();
  assert.equal(grant.delivery, 'hls');
  assert.equal(grant.prefetchUrls.length, 4);
  const master = await h.get(grant.url);
  assert.match(await master.text(), /v360\/index.m3u8/);
  const playlist = await h.get(new URL('v360/index.m3u8', grant.url));
  assert.match(await playlist.text(), /#EXT-X-TARGETDURATION:2/);
  const url = new URL('v360/seg-000000.m4s', grant.url);
  const segment = await h.get(url, { headers: { origin: 'https://a.test' } });
  assert.equal(segment.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual(new Uint8Array(await segment.arrayBuffer()), new Uint8Array([4, 5, 6, 7]));
  await h.drain(); const before = h.reads();
  const hit = await h.get(url, { headers: { origin: 'https://b.test' } });
  assert.equal(hit.headers.get('x-media-cache'), 'HIT');
  assert.equal(hit.headers.get('access-control-allow-origin'), 'https://b.test');
  await hit.arrayBuffer();
  assert.equal(h.reads(), before);
  const range = await h.get(url, { headers: { range: 'bytes=-2' } });
  assert.equal(range.status, 206);
  assert.deepEqual(new Uint8Array(await range.arrayBuffer()), new Uint8Array([6, 7]));
});

test('HLS never serves cached data before token validation and restricts paths to this package', async t => {
  const h = harness(t), grant = await h.grant();
  await (await h.get(grant.url)).text(); await h.drain();
  const before = h.reads(), now = Date.now;
  Date.now = () => now() + 601000;
  try { assert.equal((await h.get(grant.url)).status, 403); } finally { Date.now = now; }
  for (const file of ['v360/seg-999999.m4s', 'v480/init.mp4', 'ready.json', 'v360/%2Fsource.mp4']) {
    assert.equal((await h.get(new URL(file, grant.url))).status, 404);
  }
  assert.equal(h.reads(), before);
});

test('missing, incomplete or stale HLS packages fall back to MP4; original previews stay MP4', async t => {
  const h = harness(t);
  assert.equal((await h.grant({ delivery: undefined })).delivery, 'mp4');
  h.objects.delete(`${root}/ready.json`);
  assert.equal((await h.grant()).delivery, 'mp4');
  h.put(`${root}/ready.json`, JSON.stringify({ ...marker, sourceEtag: 'old-version' }));
  assert.equal((await h.grant()).delivery, 'mp4');
  h.put(`${root}/ready.json`, JSON.stringify(marker)); h.env.MEDIA_HLS = 'false';
  assert.equal((await h.grant()).delivery, 'mp4');
});

test('HLS prewarm is bounded to lowest rendition startup files and missing segments are not cached', async t => {
  const h = harness(t), grant = await h.grant({ prewarm: true });
  await h.drain();
  assert.equal(h.entries.size, 4);
  const first = await h.get(grant.prefetchUrls[3]);
  assert.equal(first.headers.get('x-media-cache'), 'HIT'); await first.arrayBuffer();
  const missing = await h.get(new URL('v360/seg-000001.m4s', grant.url));
  assert.equal(missing.status, 404); await h.drain();
  assert.equal(h.entries.size, 4);
});

test('cold HLS segments stream first bytes while the rest is still arriving', { timeout: 3000 }, async t => {
  const h = harness(t), grant = await h.grant();
  let controller;
  h.env.MEDIA_BUCKET.get = async () => ({ size: 4, httpEtag: '"segment"',
    body: new ReadableStream({ start(value) { controller = value; } }) });
  const response = await h.get(new URL('v360/seg-000000.m4s', grant.url));
  const reader = response.body.getReader(); controller.enqueue(new Uint8Array([4]));
  assert.deepEqual((await reader.read()).value, new Uint8Array([4]));
  assert.equal(h.entries.size, 0);
  controller.enqueue(new Uint8Array([5, 6, 7])); controller.close();
  await reader.read(); await reader.read(); await h.drain();
  assert.equal(h.entries.size, 1);
});
