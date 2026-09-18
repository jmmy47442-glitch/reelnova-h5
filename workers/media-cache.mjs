// Cache API rejects 206 responses. Store bounded, aligned blocks as internal
// 200 responses, then slice/stream the exact range requested by the browser.
export const MEDIA_BLOCK_BYTES = 1024 * 1024;
const MAX_BLOCKS_PER_REQUEST = 16;

export const mediaCache = (env, ctx) => env.MEDIA_EDGE_CACHE !== 'false' && ctx?.waitUntil
  ? globalThis.caches?.default : undefined;

export const mediaCacheIdentity = async (url, payload) => {
  // Include the entire signed URL (including query parameters), and version.
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(
    JSON.stringify([url, payload.key, payload.etag, payload.size]),
  ));
  return `${new URL(url).origin}/__media_cache/v1/${Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('')}`;
};

const readObject = async (env, payload, offset, length) => {
  const object = await env.MEDIA_BUCKET.get(payload.key, {
    range: { offset, length }, onlyIf: { etagMatches: payload.etag },
  });
  if (!object?.body) throw new Error('Video object missing or changed');
  return object;
};

export const readMediaBlock = async (env, ctx, payload, identity, offset) => {
  const cache = mediaCache(env, ctx);
  const length = Math.min(MEDIA_BLOCK_BYTES, payload.size - offset);
  const key = new Request(`${identity}/${offset}`);
  if (cache) {
    try {
      const hit = await cache.match(key);
      if (hit?.status === 200 && Number(hit.headers.get('content-length')) === length) {
        const bytes = new Uint8Array(await hit.arrayBuffer());
        if (bytes.length === length) return { bytes, hit: true };
      }
    } catch { /* Cache failure must not prevent R2 playback. */ }
  }
  const object = await readObject(env, payload, offset, length);
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (bytes.length !== length) throw new Error('Incomplete video block');
  const ttl = Math.min(3600, Math.floor(payload.expires - Date.now() / 1000));
  if (cache && ttl > 0) {
    const response = new Response(bytes, { headers: {
      'content-type': 'application/octet-stream', 'content-length': String(length),
      'cache-control': `public, max-age=${ttl}, s-maxage=${ttl}`,
    } });
    ctx.waitUntil(Promise.resolve().then(() => cache.put(key, response)).catch(() => undefined));
  }
  return { bytes, hit: false };
};

export const streamCachedMedia = async (request, env, ctx, payload, range) => {
  const identity = await mediaCacheIdentity(request.url, payload);
  let offset = range?.offset ?? 0;
  const end = offset + (range?.length ?? payload.size);
  let blockOffset = Math.floor(offset / MEDIA_BLOCK_BYTES) * MEDIA_BLOCK_BYTES;
  let block = await readMediaBlock(env, ctx, payload, identity, blockOffset);
  const cacheStatus = block.hit ? 'HIT' : 'MISS';
  let blocks = 1;
  let cancelled = false;
  let tailReader;
  const body = new ReadableStream({
    async pull(controller) {
      try {
        if (cancelled) return;
        if (offset >= end) { controller.close(); return; }
        if (!block && blocks >= MAX_BLOCKS_PER_REQUEST) {
          // Large/open-ended MP4 requests must not exhaust Worker subrequest
          // limits or buffer a whole film. Stream the remaining bytes from R2.
          if (!tailReader) {
            const object = await readObject(env, payload, offset, end - offset);
            tailReader = new Response(object.body).body.getReader();
            if (cancelled) { await tailReader.cancel(); return; }
          }
          const result = await tailReader.read();
          if (cancelled) return;
          if (result.done) {
            if (offset !== end) throw new Error('Incomplete video stream');
            controller.close();
          } else {
            offset += result.value.byteLength;
            controller.enqueue(result.value);
          }
          return;
        }
        if (!block) {
          blockOffset = Math.floor(offset / MEDIA_BLOCK_BYTES) * MEDIA_BLOCK_BYTES;
          block = await readMediaBlock(env, ctx, payload, identity, blockOffset);
          blocks++;
        }
        if (cancelled) return;
        const to = Math.min(end, blockOffset + block.bytes.length);
        controller.enqueue(block.bytes.slice(offset - blockOffset, to - blockOffset));
        offset = to;
        block = undefined;
      } catch (error) { if (!cancelled) controller.error(error); }
    },
    async cancel() { cancelled = true; block = undefined; await tailReader?.cancel(); },
  }, { highWaterMark: 0 });
  // Workers ignores manually supplied Content-Length for ordinary streams.
  // A fixed-length stream preserves it on the wire and detects truncation.
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
