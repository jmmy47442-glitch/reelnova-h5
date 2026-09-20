import { mediaCache, mediaCacheIdentity, MEDIA_CACHE_TTL_SECONDS } from './media-cache.mjs';

export const readHlsPackage = async (env, assetId, sourceEtag) => {
  const root = `hls/${assetId}/${encodeURIComponent(sourceEtag)}`;
  try {
    const marker = await env.MEDIA_BUCKET.get(`${root}/ready.json`);
    if (!marker || marker.size > 16384) return null;
    const data = await marker.json();
    if (data.version !== 1 || data.assetId !== assetId || data.sourceEtag !== sourceEtag
      || !/^[0-9a-f-]{36}$/i.test(data.buildId) || !Array.isArray(data.renditions)
      || !data.renditions.length || data.renditions.length > 4
      || new Set(data.renditions.map(v => v.id)).size !== data.renditions.length) return null;
    if (data.renditions.some(v => !/^v(360|480|720|1080)$/.test(v.id)
      || !Number.isInteger(v.segments) || v.segments < 1 || v.segments > 10801)) return null;
    return { prefix: `${root}/${data.buildId}/`, renditions: data.renditions };
  } catch { return null; }
};

const allowedFile = (payload, file) => {
  if (file === 'master.m3u8') return true;
  const match = /^(v(?:360|480|720|1080))\/(index\.m3u8|init\.mp4|seg-(\d{6})\.m4s)$/.exec(file);
  const level = match && payload.renditions?.find(v => v.id === match[1]);
  return Boolean(level && (!match[3] || Number(match[3]) < level.segments));
};

// Caller must verify the encrypted token before entering this function.
export const serveHlsFile = async (request, env, ctx, payload, file, requestCors, parseRange) => {
  const error = (message, status) => new Response(message, { status, headers: { ...requestCors, 'cache-control': 'no-store' } });
  if (!allowedFile(payload, file)) return error('Not found', 404);
  const cache = mediaCache(env, ctx);
  const objectKey = `${payload.prefix}${file}`;
  const identity = await mediaCacheIdentity(request.url, { key: objectKey, etag: payload.prefix });
  const cacheKey = new Request(identity);
  let response, cacheStatus = cache ? 'MISS' : 'BYPASS';
  if (cache) {
    try { response = await cache.match(cacheKey); } catch { /* R2 fallback */ }
    if (response?.status !== 200) response = undefined;
    if (response) cacheStatus = 'HIT';
  }
  if (!response) {
    const object = request.method === 'HEAD' ? await env.MEDIA_BUCKET.head(objectKey) : await env.MEDIA_BUCKET.get(objectKey);
    if (!object) return error('Not found', 404);
    if (object.size > 8 * 1024 * 1024) return error('Invalid HLS segment size', 502);
    const headers = new Headers({
      'content-type': file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp4',
      'content-length': String(object.size), etag: object.httpEtag,
    });
    response = new Response(request.method === 'HEAD' ? null : object.body, { headers });
    if (cache && request.method !== 'HEAD') {
      const copy = response.clone();
      ctx.waitUntil((async () => {
        const bytes = await copy.arrayBuffer();
        if (bytes.byteLength !== object.size) return;
        const internalHeaders = new Headers(headers);
        internalHeaders.set('cache-control', `public, max-age=${MEDIA_CACHE_TTL_SECONDS}, s-maxage=${MEDIA_CACHE_TTL_SECONDS}`);
        await cache.put(cacheKey, new Response(bytes, { headers: internalHeaders }));
      })().catch(() => undefined));
    }
  }
  const headers = new Headers(response.headers);
  Object.entries(requestCors).forEach(([key, value]) => headers.set(key, value));
  headers.set('cache-control', 'private, no-store');
  headers.set('accept-ranges', 'bytes');
  headers.set('x-media-cache', cacheStatus);
  if (request.method === 'HEAD') { void response.body?.cancel(); return new Response(null, { headers }); }
  const range = parseRange(request.headers.get('range'), Number(headers.get('content-length')));
  if (range === false) {
    void response.body?.cancel();
    return new Response(null, { status: 416, headers: { ...requestCors, 'cache-control': 'no-store', 'content-range': `bytes */${headers.get('content-length')}` } });
  }
  if (range) {
    const bytes = await response.arrayBuffer();
    headers.set('content-range', `bytes ${range.offset}-${range.offset + range.length - 1}/${bytes.byteLength}`);
    headers.set('content-length', String(range.length));
    return new Response(bytes.slice(range.offset, range.offset + range.length), { status: 206, headers });
  }
  // Full HLS objects stream directly. No wait for the complete segment before
  // returning headers or the first byte; only the cache branch buffers it.
  return new Response(response.body, { headers });
};
