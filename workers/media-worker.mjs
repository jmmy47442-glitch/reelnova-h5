const encoder = new TextEncoder();

const bytesToHex = (bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
const base64Url = (value) => btoa(String.fromCharCode(...value)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '');
const decodeBase64Url = (value) => Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(value.length / 4) * 4, '=')), (character) => character.charCodeAt(0));

const hmac = async (value, secret) => {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
};

const timingSafeEqual = (left, right) => {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
};

const json = (value, status = 200, extraHeaders = {}) => new Response(JSON.stringify(value), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', ...extraHeaders },
});

const cors = (request, env) => {
  const origin = request.headers.get('origin') || '';
  const allowed = String(env.APP_ORIGINS || '').split(',').map((item) => item.trim()).filter(Boolean);
  return allowed.includes(origin) ? {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'PUT,DELETE,OPTIONS',
    'access-control-allow-headers': 'authorization,content-type',
    'access-control-expose-headers': 'etag',
    'access-control-max-age': '86400',
    vary: 'Origin',
  } : {};
};

const verifyServerRequest = async (request, env, rawBody) => {
  const timestamp = request.headers.get('x-reelnova-timestamp') || '';
  const signature = request.headers.get('x-reelnova-signature') || '';
  if (!/^\d+$/.test(timestamp) || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const expected = bytesToHex(await hmac(`${timestamp}.${rawBody}`, env.MEDIA_WORKER_SECRET));
  return timingSafeEqual(signature, expected);
};

const encryptionKey = async (secret) => crypto.subtle.importKey(
  'raw', await crypto.subtle.digest('SHA-256', encoder.encode(secret)), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'],
);

const createToken = async (payload, secret) => {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, await encryptionKey(secret), encoder.encode(JSON.stringify(payload)),
  ));
  return `${base64Url(iv)}.${base64Url(ciphertext)}`;
};

const readToken = async (token, secret) => {
  const [iv, ciphertext, extra] = token.split('.');
  if (!iv || !ciphertext || extra) return null;
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: decodeBase64Url(iv) }, await encryptionKey(secret), decodeBase64Url(ciphertext),
    );
    const value = JSON.parse(new TextDecoder().decode(plaintext));
    return value.expires > Date.now() / 1000 ? value : null;
  } catch {
    return null;
  }
};

const imageTypes = new Map([
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
]);
const maximumImageBytes = 10 * 1024 * 1024;

const validSeriesImageKey = (key, seriesId, contentType) => {
  const extension = imageTypes.get(contentType);
  return Boolean(extension && /^[a-z0-9_-]{2,100}$/i.test(seriesId)
    && key === `posters/${seriesId}/${key.split('/').at(-1)}`
    && new RegExp(`^posters/${seriesId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/cover-[0-9a-f-]{36}\\.${extension}$`, 'i').test(key));
};

const publicImageUrl = (env, origin, key) => `${String(env.PUBLIC_BASE_URL || origin).replace(/\/$/, '')}/${key}`;

const matchesImageSignature = (bytes, contentType) => {
  if (contentType === 'image/jpeg') return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (contentType === 'image/png') return bytes.length >= 8
    && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((value, index) => bytes[index] === value);
  if (contentType === 'image/webp') return bytes.length >= 12
    && new TextDecoder().decode(bytes.slice(0, 4)) === 'RIFF'
    && new TextDecoder().decode(bytes.slice(8, 12)) === 'WEBP';
  return false;
};

const createImageUpload = async (env, origin, body) => {
  const objectKey = String(body.objectKey || '');
  const seriesId = String(body.seriesId || '');
  const contentType = String(body.contentType || '').toLowerCase();
  const fileSizeBytes = Number(body.fileSizeBytes);
  if (!validSeriesImageKey(objectKey, seriesId, contentType)
    || !Number.isSafeInteger(fileSizeBytes) || fileSizeBytes <= 0 || fileSizeBytes > maximumImageBytes) {
    throw new Error('Invalid series cover upload request');
  }
  const expires = Math.floor(Date.now() / 1000) + 15 * 60;
  const uploadToken = await createToken({
    kind: 'series-cover', key: objectKey, seriesId, contentType, fileSizeBytes, expires,
  }, env.MEDIA_WORKER_SECRET);
  return {
    objectKey,
    uploadUrl: `${origin}/images/upload`,
    uploadToken,
    expiresAt: new Date(expires * 1000).toISOString(),
  };
};

const putImage = async (request, env, requestCors) => {
  const token = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const payload = await readToken(token, env.MEDIA_WORKER_SECRET);
  const contentType = String(request.headers.get('content-type') || '').toLowerCase().split(';')[0].trim();
  const declaredSize = Number(request.headers.get('content-length'));
  if (!payload || payload.kind !== 'series-cover' || contentType !== payload.contentType
    || !Number.isSafeInteger(declaredSize) || declaredSize !== payload.fileSizeBytes
    || declaredSize <= 0 || declaredSize > maximumImageBytes) {
    return json({ error: 'Invalid image upload token or metadata' }, 401, requestCors);
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength !== payload.fileSizeBytes) {
    return json({ error: 'Uploaded image size does not match the signed request' }, 400, requestCors);
  }
  if (!matchesImageSignature(bytes, payload.contentType)) {
    return json({ error: 'Uploaded file content is not a valid JPG, PNG or WebP image' }, 415, requestCors);
  }
  const object = await env.MEDIA_BUCKET.put(payload.key, bytes, {
    httpMetadata: { contentType: payload.contentType, cacheControl: 'public, max-age=31536000, immutable' },
    customMetadata: { managedBy: 'reelnova', kind: 'series-cover', seriesId: payload.seriesId },
  });
  return json({ objectKey: payload.key, etag: object?.httpEtag || '' }, 200, {
    ...requestCors,
    etag: object?.httpEtag || '',
  });
};

const verifyImage = async (env, origin, body) => {
  const objectKey = String(body.objectKey || '');
  const seriesId = String(body.seriesId || '');
  const object = await env.MEDIA_BUCKET.head(objectKey);
  const contentType = String(object?.httpMetadata?.contentType || '').toLowerCase();
  if (!object || !validSeriesImageKey(objectKey, seriesId, contentType)
    || object.customMetadata?.managedBy !== 'reelnova'
    || object.customMetadata?.kind !== 'series-cover'
    || object.customMetadata?.seriesId !== seriesId
    || object.size <= 0 || object.size > maximumImageBytes) {
    throw new Error('Uploaded series cover could not be verified');
  }
  return { objectKey, publicUrl: publicImageUrl(env, origin, objectKey), contentType, size: object.size };
};

const servePublicImage = async (request, env, objectKey) => {
  if (!/^posters\/[a-z0-9_-]{2,100}\/cover-[0-9a-f-]{36}\.(?:jpg|png|webp)$/i.test(objectKey)) {
    return new Response('Not found', { status: 404 });
  }
  const object = request.method === 'HEAD'
    ? await env.MEDIA_BUCKET.head(objectKey)
    : await env.MEDIA_BUCKET.get(objectKey);
  if (!object || object.customMetadata?.kind !== 'series-cover') return new Response('Not found', { status: 404 });
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('content-length', String(object.size));
  headers.set('etag', object.httpEtag);
  headers.set('cache-control', 'public, max-age=31536000, immutable');
  headers.set('x-content-type-options', 'nosniff');
  return new Response(request.method === 'HEAD' ? null : object.body, { status: 200, headers });
};

const streamApi = async (env, path, options = {}) => {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/stream${path}`, {
    ...options,
    headers: { authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, 'content-type': 'application/json', ...(options.headers || {}) },
  });
  const payload = await response.json();
  if (!response.ok || !payload.success) {
    const details = [...(payload.errors || []), ...(payload.messages || [])]
      .map((item) => item?.message)
      .filter(Boolean)
      .join('; ');
    throw new Error(details || 'Cloudflare Stream request failed');
  }
  return payload.result;
};

const verifyPlaybackGrant = async (env, body) => {
  if (!env.APP_BASE_URL || !body.grant) return false;
  const response = await fetch(`${String(env.APP_BASE_URL).replace(/\/$/, '')}/api/internal/media/playback-grant`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ uid: body.uid, exp: body.exp, grant: body.grant }),
  });
  if (!response.ok) return false;
  const payload = await response.json().catch(() => ({}));
  return payload?.data?.authorized === true
    && payload.data.uid === body.uid
    && payload.data.expires === Math.floor(Number(body.exp));
};

const parseByteRange = (value, size) => {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || (!match[1] && !match[2]) || size <= 0) return false;
  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return false;
    const length = Math.min(suffixLength, size);
    return { offset: size - length, length };
  }
  const offset = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(requestedEnd)
    || offset < 0 || offset >= size || requestedEnd < offset) return false;
  const end = Math.min(requestedEnd, size - 1);
  return { offset, length: end - offset + 1 };
};

const writeObjectHeaders = (headers, object, contentLength = object.size) => {
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set('accept-ranges', 'bytes');
  headers.set('cache-control', 'private, max-age=0');
  headers.set('content-length', String(contentLength));
};

const serveIngestObject = async (request, env, encodedToken) => {
  const payload = await readToken(decodeURIComponent(encodedToken), env.MEDIA_WORKER_SECRET);
  if (!payload?.key) return new Response('Expired ingest URL', { status: 403 });
  const metadata = await env.MEDIA_BUCKET.head(payload.key);
  if (!metadata) return new Response('Not found', { status: 404 });
  const headers = new Headers();

  if (request.method === 'HEAD') {
    writeObjectHeaders(headers, metadata);
    return new Response(null, { status: 200, headers });
  }

  const range = parseByteRange(request.headers.get('range'), metadata.size);
  if (range === false) {
    headers.set('accept-ranges', 'bytes');
    headers.set('content-range', `bytes */${metadata.size}`);
    return new Response(null, { status: 416, headers });
  }
  const object = await env.MEDIA_BUCKET.get(payload.key, range ? { range } : undefined);
  if (!object) return new Response('Not found', { status: 404 });
  writeObjectHeaders(headers, object, range?.length ?? metadata.size);
  if (range) {
    headers.set('content-range', `bytes ${range.offset}-${range.offset + range.length - 1}/${metadata.size}`);
  }
  return new Response(object.body, { status: range ? 206 : 200, headers });
};

const findStreamCopy = async (env, idempotencyKey, metadata = {}) => {
  const videos = await streamApi(env, `?creator=${encodeURIComponent(idempotencyKey)}&limit=10&asc=true`);
  const exact = Array.isArray(videos) ? videos.find((video) => video.creator === idempotencyKey) : null;
  if (exact) return exact;
  // Pre-0017 copies did not set creator; recover those by their immutable asset metadata.
  const assetId = String(metadata.assetId || '');
  if (!assetId) return null;
  const legacyVideos = await streamApi(env, `?search=${encodeURIComponent(assetId)}&limit=10&asc=true`);
  return Array.isArray(legacyVideos)
    ? legacyVideos.find((video) => String(video.meta?.assetId || '') === assetId) || null
    : null;
};

const startStreamCopy = async (env, objectKey, metadata, idempotencyKey) => {
  const existing = await findStreamCopy(env, idempotencyKey, metadata);
  if (existing?.uid) return existing;
  const ingestToken = await createToken({ key: objectKey, expires: Math.floor(Date.now() / 1000) + 3600 }, env.MEDIA_WORKER_SECRET);
  const sourceUrl = `${env.PUBLIC_BASE_URL.replace(/\/$/, '')}/ingest/${encodeURIComponent(ingestToken)}`;
  return streamApi(env, '/copy', {
    method: 'POST',
    headers: { 'Upload-Creator': idempotencyKey },
    body: JSON.stringify({ url: sourceUrl, creator: idempotencyKey, meta: { ...metadata, idempotencyKey }, requireSignedURLs: true }),
  });
};

const uploadMarkerKey = (idempotencyKey) => `_reelnova/upload-sessions/${idempotencyKey}.json`;

const readUploadMarker = async (env, idempotencyKey) => {
  const object = await env.MEDIA_BUCKET.get(uploadMarkerKey(idempotencyKey));
  if (!object) return null;
  try { return await object.json(); } catch { return null; }
};

const createOrResumeUpload = async (env, origin, body) => {
  if (!/^upload:[0-9a-f-]{36}$/i.test(body.idempotencyKey || '') || !body.sessionId || !body.completionKey
    || !body.streamIdempotencyKey || !body.objectKey
    || !body.contentType || !Number.isFinite(body.fileSizeBytes)) throw new Error('Invalid upload request');
  const existing = await readUploadMarker(env, body.idempotencyKey);
  let uploadId = existing?.uploadId;
  if (existing && (existing.sessionId !== body.sessionId || existing.objectKey !== body.objectKey)) {
    throw new Error('Upload idempotency key conflict');
  }
  const expires = Math.floor(Date.now() / 1000) + 24 * 60 * 60;
  if (!uploadId) {
    const upload = await env.MEDIA_BUCKET.createMultipartUpload(body.objectKey, {
      httpMetadata: { contentType: body.contentType },
      customMetadata: {
        managedBy: 'reelnova', uploadSessionId: body.sessionId, uploadIdempotencyKey: body.idempotencyKey,
        r2CompletionKey: body.completionKey, assetId: String(body.metadata?.assetId || ''),
      },
    });
    uploadId = upload.uploadId;
    try {
      await env.MEDIA_BUCKET.put(uploadMarkerKey(body.idempotencyKey), JSON.stringify({
        uploadId, sessionId: body.sessionId, completionKey: body.completionKey,
        streamIdempotencyKey: body.streamIdempotencyKey, objectKey: body.objectKey, contentType: body.contentType,
        fileSizeBytes: body.fileSizeBytes, expiresAt: new Date(expires * 1000).toISOString(), createdAt: new Date().toISOString(),
      }), { httpMetadata: { contentType: 'application/json' }, customMetadata: { managedBy: 'reelnova', kind: 'upload-session', sessionId: body.sessionId } });
    } catch (error) {
      await upload.abort().catch(() => undefined);
      throw error;
    }
  }
  const uploadToken = await createToken({ key: body.objectKey, uploadId, expires }, env.MEDIA_WORKER_SECRET);
  return {
    uploadId,
    objectKey: body.objectKey,
    uploadUrl: `${origin}/uploads/${encodeURIComponent(uploadId)}`,
    uploadToken,
    partSizeBytes: 10 * 1024 * 1024,
    expiresAt: new Date(expires * 1000).toISOString(),
  };
};

const completeUpload = async (env, body, uploadId) => {
  if (body.uploadId !== uploadId || !body.sessionId || !body.completionKey || !body.streamIdempotencyKey
    || !body.objectKey || !Array.isArray(body.parts) || !body.parts.length) throw new Error('Invalid completion request');
  let object = await env.MEDIA_BUCKET.head(body.objectKey);
  if (!object) {
    const upload = env.MEDIA_BUCKET.resumeMultipartUpload(body.objectKey, uploadId);
    object = await upload.complete(body.parts);
  } else if (object.customMetadata?.uploadSessionId && object.customMetadata.uploadSessionId !== body.sessionId) {
    throw new Error('R2 completion idempotency key conflict');
  } else if (object.customMetadata?.r2CompletionKey && object.customMetadata.r2CompletionKey !== body.completionKey) {
    throw new Error('R2 completion idempotency key conflict');
  }
  try {
    const stream = await startStreamCopy(env, body.objectKey, body.metadata || {}, body.streamIdempotencyKey);
    if (!stream?.uid) throw new Error('Cloudflare Stream copy returned no UID');
    return { etag: object.httpEtag, streamUid: stream.uid };
  } catch (error) {
    return { etag: object.httpEtag, streamUid: null, streamError: error instanceof Error ? error.message : 'Stream copy failed' };
  }
};

const abortUpload = async (env, body, uploadId) => {
  if (body.uploadId !== uploadId || !body.sessionId || !body.objectKey || !body.idempotencyKey) {
    throw new Error('Invalid upload cancellation request');
  }
  if (!uploadId.startsWith('pending:')) {
    await env.MEDIA_BUCKET.resumeMultipartUpload(body.objectKey, uploadId).abort().catch((error) => {
      if (!/not found|no such upload|does not exist/i.test(error instanceof Error ? error.message : '')) throw error;
    });
  }
  await env.MEDIA_BUCKET.delete(uploadMarkerKey(body.idempotencyKey));
  return { uploadId, sessionId: body.sessionId, status: 'aborted' };
};

const reconcileResources = async (env, body) => {
  const keepObjectKeys = new Set(Array.isArray(body.keepObjectKeys) ? body.keepObjectKeys : []);
  const keepStreamUids = new Set(Array.isArray(body.keepStreamUids) ? body.keepStreamUids : []);
  const keepSessionIds = new Set(Array.isArray(body.keepSessionIds) ? body.keepSessionIds : []);
  const cutoff = Date.now() - Math.max(24, Number(body.graceHours) || 24) * 60 * 60 * 1000;
  const result = { abortedSessionIds: [], deletedObjectKeys: [], deletedStreamUids: [], deletedMarkerKeys: [], errors: [] };

  for (const candidate of Array.isArray(body.abortUploads) ? body.abortUploads.slice(0, 100) : []) {
    try {
      if (candidate.uploadId && candidate.objectKey && !String(candidate.uploadId).startsWith('pending:')) {
        await env.MEDIA_BUCKET.resumeMultipartUpload(candidate.objectKey, candidate.uploadId).abort();
      }
      if (candidate.idempotencyKey) await env.MEDIA_BUCKET.delete(uploadMarkerKey(candidate.idempotencyKey));
      result.abortedSessionIds.push(candidate.sessionId);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Multipart abort failed';
      // A completed or already-aborted multipart is also reconciled; object cleanup is handled below.
      if (/not found|no such upload|does not exist/i.test(message)) result.abortedSessionIds.push(candidate.sessionId);
      else result.errors.push({ resource: `multipart:${candidate.sessionId}`, message });
    }
  }

  let cursor;
  do {
    const listed = await env.MEDIA_BUCKET.list({ prefix: 'originals/', limit: 1000, cursor, include: ['customMetadata'] });
    for (const object of listed.objects) {
      if (object.customMetadata?.managedBy !== 'reelnova' && !object.key.startsWith('originals/')) continue;
      if (keepObjectKeys.has(object.key) || object.uploaded.getTime() >= cutoff) continue;
      try {
        await env.MEDIA_BUCKET.delete(object.key);
        result.deletedObjectKeys.push(object.key);
      } catch (error) {
        result.errors.push({ resource: `r2:${object.key}`, message: error instanceof Error ? error.message : 'R2 delete failed' });
      }
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);

  cursor = undefined;
  do {
    const listed = await env.MEDIA_BUCKET.list({ prefix: '_reelnova/upload-sessions/', limit: 1000, cursor, include: ['customMetadata'] });
    for (const object of listed.objects) {
      const sessionId = object.customMetadata?.sessionId;
      if (!sessionId || keepSessionIds.has(sessionId) || object.uploaded.getTime() >= cutoff) continue;
      try {
        const markerObject = await env.MEDIA_BUCKET.get(object.key);
        const marker = markerObject ? await markerObject.json() : null;
        if (marker?.uploadId && marker?.objectKey) {
          await env.MEDIA_BUCKET.resumeMultipartUpload(marker.objectKey, marker.uploadId).abort().catch((error) => {
            if (!/not found|no such upload|does not exist/i.test(error instanceof Error ? error.message : '')) throw error;
          });
        }
        await env.MEDIA_BUCKET.delete(object.key);
        result.deletedMarkerKeys.push(object.key);
      } catch (error) {
        result.errors.push({ resource: `marker:${object.key}`, message: error instanceof Error ? error.message : 'Upload marker cleanup failed' });
      }
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);

  try {
    let start;
    for (let page = 0; page < 100; page += 1) {
      const videos = await streamApi(env, `?limit=1000&asc=true${start ? `&start=${encodeURIComponent(start)}` : ''}`);
      const pageVideos = Array.isArray(videos) ? videos : [];
      for (const video of pageVideos) {
        if (!String(video.creator || '').startsWith('reelnova:') && !video.meta?.assetId) continue;
        if (keepStreamUids.has(video.uid)
          || !video.created || Date.parse(video.created) >= cutoff) continue;
        try {
          await streamApi(env, `/${encodeURIComponent(video.uid)}`, { method: 'DELETE' });
          result.deletedStreamUids.push(video.uid);
        } catch (error) {
          result.errors.push({ resource: `stream:${video.uid}`, message: error instanceof Error ? error.message : 'Stream delete failed' });
        }
      }
      if (pageVideos.length < 1000 || !pageVideos.at(-1)?.created) break;
      start = new Date(Date.parse(pageVideos.at(-1).created) + 1).toISOString();
    }
  } catch (error) {
    result.errors.push({ resource: 'stream:list', message: error instanceof Error ? error.message : 'Stream list failed' });
  }
  return result;
};

const triggerApplicationReconciliation = async (env, path) => {
  if (!env.APP_BASE_URL) throw new Error('APP_BASE_URL is not configured');
  const rawBody = JSON.stringify({ triggeredAt: new Date().toISOString() });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = bytesToHex(await hmac(`${timestamp}.${rawBody}`, env.MEDIA_WORKER_SECRET));
  const response = await fetch(`${String(env.APP_BASE_URL).replace(/\/$/, '')}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-reelnova-timestamp': timestamp, 'x-reelnova-signature': signature },
    body: rawBody,
  });
  if (!response.ok) throw new Error(`Application reconciliation failed (${response.status}): ${await response.text()}`);
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const requestCors = cors(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: requestCors });

    try {
      if (request.method === 'POST' && url.pathname === '/uploads') {
        const rawBody = await request.text();
        if (!await verifyServerRequest(request, env, rawBody)) return json({ error: 'Invalid server signature' }, 401);
        const body = JSON.parse(rawBody);
        return json(await createOrResumeUpload(env, url.origin, body));
      }

      if (request.method === 'POST' && url.pathname === '/images/uploads') {
        const rawBody = await request.text();
        if (!await verifyServerRequest(request, env, rawBody)) return json({ error: 'Invalid server signature' }, 401);
        return json(await createImageUpload(env, url.origin, JSON.parse(rawBody)));
      }

      if (request.method === 'PUT' && url.pathname === '/images/upload') {
        return putImage(request, env, requestCors);
      }

      if (request.method === 'POST' && url.pathname === '/images/verify') {
        const rawBody = await request.text();
        if (!await verifyServerRequest(request, env, rawBody)) return json({ error: 'Invalid server signature' }, 401);
        return json(await verifyImage(env, url.origin, JSON.parse(rawBody)));
      }

      if (request.method === 'POST' && url.pathname === '/stream/token') {
        const rawBody = await request.text();
        const body = JSON.parse(rawBody);
        if (!/^[0-9a-f]{32}$/i.test(String(body.uid || ''))) return json({ error: 'Invalid Stream UID' }, 400);
        const serverAuthorized = await verifyServerRequest(request, env, rawBody);
        if (!serverAuthorized && !await verifyPlaybackGrant(env, body)) {
          return json({ error: 'Invalid Stream playback authorization' }, 401);
        }
        const now = Math.floor(Date.now() / 1000);
        const exp = Math.min(now + 15 * 60, Math.max(now + 60, Math.floor(Number(body.exp) || now + 10 * 60)));
        return json(await streamApi(env, `/${encodeURIComponent(body.uid)}/token`, {
          method: 'POST', body: JSON.stringify({ exp }),
        }));
      }

      const partMatch = url.pathname.match(/^\/uploads\/([^/]+)\/parts\/(\d+)$/);
      if (partMatch && request.method === 'PUT') {
        const token = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
        const payload = await readToken(token, env.MEDIA_WORKER_SECRET);
        const uploadId = decodeURIComponent(partMatch[1]);
        const partNumber = Number(partMatch[2]);
        if (!payload || payload.uploadId !== uploadId || partNumber < 1 || partNumber > 10000 || !request.body) return json({ error: 'Invalid upload token' }, 401, requestCors);
        const upload = env.MEDIA_BUCKET.resumeMultipartUpload(payload.key, uploadId);
        const part = await upload.uploadPart(partNumber, request.body);
        return json({ partNumber: part.partNumber, etag: part.etag }, 200, { ...requestCors, etag: part.etag });
      }

      const completeMatch = url.pathname.match(/^\/uploads\/([^/]+)\/complete$/);
      if (completeMatch && request.method === 'POST') {
        const rawBody = await request.text();
        if (!await verifyServerRequest(request, env, rawBody)) return json({ error: 'Invalid server signature' }, 401);
        const body = JSON.parse(rawBody);
        const uploadId = decodeURIComponent(completeMatch[1]);
        return json(await completeUpload(env, body, uploadId));
      }

      const cancelMatch = url.pathname.match(/^\/uploads\/([^/]+)$/);
      if (cancelMatch && request.method === 'DELETE') {
        const rawBody = await request.text();
        if (!await verifyServerRequest(request, env, rawBody)) return json({ error: 'Invalid server signature' }, 401);
        const body = JSON.parse(rawBody);
        const uploadId = decodeURIComponent(cancelMatch[1]);
        return json(await abortUpload(env, body, uploadId));
      }

      if (url.pathname === '/transcodes' && request.method === 'POST') {
        const rawBody = await request.text();
        if (!await verifyServerRequest(request, env, rawBody)) return json({ error: 'Invalid server signature' }, 401);
        const body = JSON.parse(rawBody);
        if (!body.objectKey || !body.streamIdempotencyKey) return json({ error: 'Object key and idempotency key are required' }, 400);
        const stream = await startStreamCopy(env, body.objectKey, body.metadata || {}, body.streamIdempotencyKey);
        return json({ streamUid: stream.uid });
      }

      if (url.pathname === '/reconcile' && request.method === 'POST') {
        const rawBody = await request.text();
        if (!await verifyServerRequest(request, env, rawBody)) return json({ error: 'Invalid server signature' }, 401);
        return json(await reconcileResources(env, JSON.parse(rawBody)));
      }

      const ingestMatch = url.pathname.match(/^\/ingest\/(.+)$/);
      if (ingestMatch && ['GET', 'HEAD'].includes(request.method)) {
        return serveIngestObject(request, env, ingestMatch[1]);
      }

      if (url.pathname.startsWith('/posters/') && ['GET', 'HEAD'].includes(request.method)) {
        return servePublicImage(request, env, decodeURIComponent(url.pathname.slice(1)));
      }

      return json({ error: 'Not found' }, 404, requestCors);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : 'Media worker error' }, 500, requestCors);
    }
  },
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(Promise.all([
      triggerApplicationReconciliation(env, '/api/internal/media/reconcile'),
      triggerApplicationReconciliation(env, '/api/internal/paypal/reconcile'),
    ]));
  },
};
