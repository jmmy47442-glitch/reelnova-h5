import assert from 'node:assert/strict';
import test from 'node:test';
import worker from '../workers/media-worker.mjs';
import { MEDIA_BLOCK_BYTES, warmMediaStart } from '../workers/media-cache.mjs';

const secret = 'edge-cache-test-secret';
const source = Uint8Array.from({ length: MEDIA_BLOCK_BYTES * 2 + 53 }, (_, i) => i % 251);
const makeUrl = async payload => {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey('raw', await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret)), 'AES-GCM', false, ['encrypt']);
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(payload)));
  return `https://media.example.test/original/${Buffer.from(iv).toString('base64url')}.${Buffer.from(encrypted).toString('base64url')}`;
};
const setup = async (t, bytes = source) => {
  const entries = new Map(), jobs = [];
  let reads = 0, heads = 0, cacheReads = 0;
  const payload = { kind: 'original-playback', assetId: 'asset', key: 'originals/source.mp4',
    etag: 'version-1', httpEtag: '"version-1"', size: bytes.length, expires: Math.floor(Date.now() / 1000) + 600 };
  const cache = {
    async match(request) { cacheReads++; return entries.get(request.url)?.clone(); },
    async put(request, response) {
      assert.equal(response.status, 200, 'Cloudflare rejects Cache API puts with status 206');
      assert.equal(request.headers.get('range'), null);
      assert.ok(!request.url.includes('/original/'), 'internal keys must not expose signatures');
      const body = await response.arrayBuffer();
      assert.equal(Number(response.headers.get('content-length')), body.byteLength);
      assert.ok(body.byteLength <= MEDIA_BLOCK_BYTES);
      entries.set(request.url, new Response(body, response));
    },
  };
  const previous = globalThis.caches;
  globalThis.caches = { default: cache };
  t.after(() => { globalThis.caches = previous; });
  const env = { MEDIA_WORKER_SECRET: secret, APP_ORIGINS: 'https://a.test,https://b.test', MEDIA_BUCKET: {
    async head() { heads++; throw new Error('Signed metadata should avoid HEAD'); },
    async get(key, options) {
      reads++;
      assert.equal(key, payload.key);
      assert.equal(options.onlyIf.etagMatches, payload.etag);
      const range = options.range || { offset: 0, length: bytes.length };
      const part = bytes.slice(range.offset, range.offset + range.length);
      return { body: part, arrayBuffer: async () => part.buffer };
    },
  } };
  const ctx = { waitUntil: task => jobs.push(task) };
  const drain = async () => { while (jobs.length) await Promise.all(jobs.splice(0)); };
  const url = await makeUrl(payload);
  const get = (range, target = url, origin = 'https://a.test') => worker.fetch(new Request(target, {
    headers: { ...(range ? { range } : {}), origin },
  }), env, ctx);
  return { env, payload, ctx, cache, entries, drain, get, url, counts: () => ({ reads, heads, cacheReads }) };
};

test('aligned blocks preserve all Range forms, serve hits without R2 and isolate response CORS', async t => {
  const h = await setup(t);
  for (const [range, start, end] of [
    ['bytes=2-5', 2, 6], ['bytes=1048570-1048580', 1048570, 1048581],
    ['bytes=-4', source.length - 4, source.length], ['bytes=2097152-', 2097152, source.length],
    ['bytes=2097152-9999999', 2097152, source.length],
  ]) {
    const response = await h.get(range);
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('content-range'), `bytes ${start}-${end - 1}/${source.length}`);
    assert.equal(response.headers.get('content-length'), String(end - start));
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), source.slice(start, end));
    await h.drain();
  }
  const before = h.counts();
  const hit = await h.get('bytes=2-10', h.url, 'https://b.test');
  assert.equal(hit.headers.get('x-media-cache'), 'HIT');
  assert.equal(hit.headers.get('access-control-allow-origin'), 'https://b.test');
  assert.deepEqual(new Uint8Array(await hit.arrayBuffer()), source.slice(2, 11));
  assert.equal(h.counts().reads, before.reads);
  assert.equal(h.counts().heads, 0);
  const full = await h.get();
  assert.equal(full.status, 200);
  assert.deepEqual(new Uint8Array(await full.arrayBuffer()), source);
});

test('expired/tampered tokens cannot read warm cache; HEAD and invalid ranges do not read data', async t => {
  const h = await setup(t);
  await (await h.get('bytes=0-20')).arrayBuffer(); await h.drain();
  const before = h.counts();
  const now = Date.now;
  Date.now = () => now() + 601_000;
  try { assert.equal((await h.get('bytes=0-20')).status, 403); }
  finally { Date.now = now; }
  assert.equal((await h.get('bytes=0-20', `${h.url}bad`)).status, 403);
  const head = await worker.fetch(new Request(h.url, { method: 'HEAD' }), h.env, h.ctx);
  assert.equal(head.status, 200); assert.equal(await head.text(), '');
  for (const range of ['bytes=99999999-', 'bytes=5-2', 'bytes=0-1,4-8', 'bytes=-0']) {
    const result = await h.get(range);
    assert.equal(result.status, 416);
    assert.equal(result.headers.get('content-range'), `bytes */${source.length}`);
  }
  assert.deepEqual(h.counts(), before);
});

test('cache identity includes signature and full query; internal keys are not public routes', async t => {
  const h = await setup(t);
  for (const url of [h.url, await makeUrl(h.payload), `${h.url}?quality=x`]) {
    const response = await h.get('bytes=0-7', url);
    assert.equal(response.headers.get('x-media-cache'), 'MISS');
    await response.arrayBuffer(); await h.drain();
  }
  assert.equal(h.counts().reads, 3);
  for (const url of h.entries.keys()) assert.equal((await worker.fetch(new Request(url), h.env, h.ctx)).status, 404);
});

test('origin errors and partial blocks are never cached, cache outages fall back to R2', async t => {
  const h = await setup(t);
  const get = h.env.MEDIA_BUCKET.get;
  for (const broken of [async () => { throw new Error('502 upstream'); }, async () => null]) {
    h.env.MEDIA_BUCKET.get = broken;
    const response = await h.get('bytes=0-7');
    assert.equal(response.status, 502); assert.equal(response.headers.get('cache-control'), 'no-store');
    await h.drain(); assert.equal(h.entries.size, 0);
  }
  h.env.MEDIA_BUCKET.get = async () => ({ body: new Uint8Array(2) });
  const truncated = await h.get('bytes=0-7');
  assert.equal(truncated.status, 206, 'headers are sent before the block finishes');
  await assert.rejects(truncated.arrayBuffer(), /Incomplete video block/);
  await h.drain(); assert.equal(h.entries.size, 0);
  h.env.MEDIA_BUCKET.get = get;
  h.cache.match = async () => { throw new Error('Cache unavailable'); };
  h.cache.put = async () => { throw new Error('Cache unavailable'); };
  const response = await h.get('bytes=0-7');
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), source.slice(0, 8));
  await h.drain();
});

test('a cold MP4 forwards its first bytes before the rest of the 1 MiB block arrives', async t => {
  const h = await setup(t);
  let controller;
  h.env.MEDIA_BUCKET.get = async () => ({ body: new ReadableStream({ start(value) { controller = value; } }) });
  // No upstream body bytes have arrived yet. Returning headers must not wait.
  const response = await h.get('bytes=0-15');
  const reader = response.body.getReader();
  controller.enqueue(source.slice(0, 16));
  assert.deepEqual((await reader.read()).value, source.slice(0, 16));
  assert.equal(h.entries.size, 0, 'the incomplete block is not cached');
  assert.equal((await reader.read()).done, true);
  controller.enqueue(source.slice(16, MEDIA_BLOCK_BYTES));
  controller.close();
  await h.drain();
  assert.equal(h.entries.size, 1);
});

test('prewarming reads only first/tail blocks and playback reuses them', async t => {
  const h = await setup(t);
  await warmMediaStart(h.url, h.env, h.ctx, h.payload); await h.drain();
  assert.equal(h.counts().reads, 2);
  const response = await h.get('bytes=0-524287');
  assert.equal(response.headers.get('x-media-cache'), 'HIT');
  await response.arrayBuffer();
  assert.equal(h.counts().reads, 2);
});

test('large open-ended responses bound cache subrequests and stream the remaining tail', async t => {
  const bytes = new Uint8Array(MEDIA_BLOCK_BYTES * 18 + 3).fill(97);
  const h = await setup(t, bytes);
  const response = await h.get('bytes=100-');
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes.slice(100));
  await h.drain();
  assert.equal(h.entries.size, 16);
  assert.equal(h.counts().reads, 17);
});

test('cache can be disabled and cancellation stops further block loads', async t => {
  const h = await setup(t);
  h.env.MEDIA_EDGE_CACHE = 'false';
  const bypass = await h.get('bytes=0-7');
  assert.equal(bypass.headers.get('x-media-cache'), 'BYPASS');
  assert.deepEqual(new Uint8Array(await bypass.arrayBuffer()), source.slice(0, 8));
  assert.equal(h.counts().cacheReads, 0);
  h.env.MEDIA_EDGE_CACHE = 'true';
  const response = await h.get();
  await response.body.cancel(); await h.drain();
  assert.equal(h.counts().reads, 2);
});
