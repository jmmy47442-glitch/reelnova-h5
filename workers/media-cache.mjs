// Cache API rejects 206 responses. Store bounded, aligned blocks as internal
// 200 responses, then slice/stream the exact range requested by the browser.
export const MEDIA_BLOCK_BYTES = 1024 * 1024;
// Only internal, versioned objects get this TTL. Public requests must still
// validate their token on every read, including when the object is cached.
export const MEDIA_CACHE_TTL_SECONDS = 24 * 60 * 60;
const MAX_BLOCKS_PER_REQUEST = 16;

export const mediaCache = (env, ctx) => env.MEDIA_EDGE_CACHE !== 'false' && ctx?.waitUntil
  ? globalThis.caches?.default : undefined;

export const mediaCacheIdentity = async (url, payload) => {
  // Callers validate authorization first. Token rotation and unrelated query
  // parameters do not change the bytes; object key/version/size do.
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(
    JSON.stringify([payload.key, payload.etag, payload.size]),
  ));
  return `${new URL(url).origin}/__media_cache/v2/${Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('')}`;
};

const readObject = async (env, payload, offset, length) => {
  const object = await env.MEDIA_BUCKET.get(payload.key, {
    range: { offset, length }, onlyIf: { etagMatches: payload.etag },
  });
  if (!object?.body) throw new Error('Video object missing or changed');
  return object;
};

const openMediaBlock = async (env, ctx, payload, identity, offset) => {
  const cache = mediaCache(env, ctx);
  const length = Math.min(MEDIA_BLOCK_BYTES, payload.size - offset);
  const key = new Request(`${identity}/${offset}`);
  if (cache) {
    try {
      const hit = await cache.match(key);
      if (hit?.status === 200 && Number(hit.headers.get('content-length')) === length) {
        return { body: hit.body, hit: true, length };
      }
    } catch { /* Cache failure must not prevent R2 playback. */ }
  }
  const object = await readObject(env, payload, offset, length);
  let body = new Response(object.body).body;
  if (cache) {
    const [playback, cacheBody] = body.tee();
    body = playback;
    // Only the bounded cache branch waits for a complete block. The playback
    // branch starts forwarding immediately after R2 responds with headers.
    ctx.waitUntil((async () => {
      const bytes = await new Response(cacheBody).arrayBuffer();
      if (bytes.byteLength !== length) return;
      await cache.put(key, new Response(bytes, { headers: {
        'content-type': 'application/octet-stream', 'content-length': String(length),
        'cache-control': `public, max-age=${MEDIA_CACHE_TTL_SECONDS}, s-maxage=${MEDIA_CACHE_TTL_SECONDS}`,
      } }));
    })().catch(() => undefined));
  }
  return { body, hit: false, length };
};

export const readMediaBlock = async (env, ctx, payload, identity, offset) => {
  const block = await openMediaBlock(env, ctx, payload, identity, offset);
  const bytes = new Uint8Array(await new Response(block.body).arrayBuffer());
  if (bytes.length !== block.length) throw new Error('Incomplete video block');
  return { bytes, hit: block.hit };
};

export const streamCachedMedia = async (request, env, ctx, payload, range) => {
  const identity = await mediaCacheIdentity(request.url, payload);
  let offset = range?.offset ?? 0;
  const end = offset + (range?.length ?? payload.size);
  let blockOffset = Math.floor(offset / MEDIA_BLOCK_BYTES) * MEDIA_BLOCK_BYTES;
  let block = await openMediaBlock(env, ctx, payload, identity, blockOffset);
  const cacheStatus = block.hit ? 'HIT' : 'MISS';
  let reader = block.body.getReader();
  let readOffset = blockOffset;
  let blockEnd = blockOffset + block.length;
  let blocks = 1;
  let cancelled = false;
  const cancelReader = () => { void reader?.cancel().catch(() => undefined); };
  const body = new ReadableStream({
    async pull(controller) {
      try {
        while (!cancelled) {
          if (offset >= end) { cancelReader(); controller.close(); return; }
          if (!reader) {
            blockOffset = offset;
            if (blocks >= MAX_BLOCKS_PER_REQUEST) {
              const object = await readObject(env, payload, offset, end - offset);
              reader = new Response(object.body).body.getReader();
              blockEnd = end;
            } else {
              block = await openMediaBlock(env, ctx, payload, identity, blockOffset);
              reader = block.body.getReader();
              blockEnd = blockOffset + block.length;
              blocks++;
            }
            readOffset = blockOffset;
          }
          if (cancelled) { cancelReader(); return; }
          const result = await reader.read();
          if (cancelled) return;
          if (result.done) {
            if (readOffset !== blockEnd) throw new Error('Incomplete video block');
            reader = undefined;
            continue;
          }
          const from = Math.max(0, offset - readOffset);
          const to = Math.min(result.value.length, end - readOffset);
          readOffset += result.value.length;
          if (readOffset > blockEnd) throw new Error('Invalid video block length');
          if (to > from) {
            const bytes = result.value.subarray(from, to);
            offset += bytes.length;
            controller.enqueue(bytes);
            return;
          }
        }
      } catch (error) { cancelReader(); if (!cancelled) controller.error(error); }
    },
    cancel() { cancelled = true; cancelReader(); },
  }, { highWaterMark: 0 });
  if (globalThis.FixedLengthStream) {
    const fixed = new globalThis.FixedLengthStream(range?.length ?? payload.size);
    ctx.waitUntil(body.pipeTo(fixed.writable).catch(() => undefined));
    return { body: fixed.readable, cacheStatus };
  }
  return { body, cacheStatus };
};

export const warmMediaStart = async (url, env, ctx, payload) => {
  if (!mediaCache(env, ctx)) return;
  const identity = await mediaCacheIdentity(url, payload);
  await readMediaBlock(env, ctx, payload, identity, 0);
  // Older MP4 files may keep moov at the end. Bound warming to two blocks.
  const tail = Math.floor((payload.size - 1) / MEDIA_BLOCK_BYTES) * MEDIA_BLOCK_BYTES;
  if (tail > 0) await readMediaBlock(env, ctx, payload, identity, tail);
};
