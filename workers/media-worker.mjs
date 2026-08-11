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

const startStreamCopy = async (env, objectKey, metadata) => {
  const ingestToken = await createToken({ key: objectKey, expires: Math.floor(Date.now() / 1000) + 3600 }, env.MEDIA_WORKER_SECRET);
  const sourceUrl = `${env.PUBLIC_BASE_URL.replace(/\/$/, '')}/ingest/${encodeURIComponent(ingestToken)}`;
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/stream/copy`, {
    method: 'POST',
    headers: { authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ url: sourceUrl, meta: metadata, requireSignedURLs: true }),
  });
  const payload = await response.json();
  if (!response.ok || !payload.success || !payload.result?.uid) {
    throw new Error(payload.errors?.[0]?.message || 'Cloudflare Stream copy failed');
  }
  return payload.result;
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
        if (!body.objectKey || !body.contentType || !Number.isFinite(body.fileSizeBytes)) return json({ error: 'Invalid upload request' }, 400);
        const upload = await env.MEDIA_BUCKET.createMultipartUpload(body.objectKey, { httpMetadata: { contentType: body.contentType } });
        const expires = Math.floor(Date.now() / 1000) + 24 * 60 * 60;
        const uploadToken = await createToken({ key: body.objectKey, uploadId: upload.uploadId, expires }, env.MEDIA_WORKER_SECRET);
        return json({
          uploadId: upload.uploadId,
          objectKey: body.objectKey,
          uploadUrl: `${url.origin}/uploads/${encodeURIComponent(upload.uploadId)}`,
          uploadToken,
          partSizeBytes: 10 * 1024 * 1024,
          expiresAt: new Date(expires * 1000).toISOString(),
        });
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
        if (body.uploadId !== uploadId || !body.objectKey || !Array.isArray(body.parts) || !body.parts.length) return json({ error: 'Invalid completion request' }, 400);
        let object = await env.MEDIA_BUCKET.head(body.objectKey);
        if (!object) {
          const upload = env.MEDIA_BUCKET.resumeMultipartUpload(body.objectKey, uploadId);
          object = await upload.complete(body.parts);
        }
        try {
          const stream = await startStreamCopy(env, body.objectKey, body.metadata || {});
          return json({ etag: object.httpEtag, streamUid: stream.uid });
        } catch (error) {
          return json({ etag: object.httpEtag, streamUid: null, streamError: error instanceof Error ? error.message : 'Stream copy failed' });
        }
      }

      if (url.pathname === '/transcodes' && request.method === 'POST') {
        const rawBody = await request.text();
        if (!await verifyServerRequest(request, env, rawBody)) return json({ error: 'Invalid server signature' }, 401);
        const body = JSON.parse(rawBody);
        if (!body.objectKey) return json({ error: 'Object key is required' }, 400);
        const stream = await startStreamCopy(env, body.objectKey, body.metadata || {});
        return json({ streamUid: stream.uid });
      }

      const ingestMatch = url.pathname.match(/^\/ingest\/(.+)$/);
      if (ingestMatch && request.method === 'GET') {
        const payload = await readToken(decodeURIComponent(ingestMatch[1]), env.MEDIA_WORKER_SECRET);
        if (!payload?.key) return new Response('Expired ingest URL', { status: 403 });
        const object = await env.MEDIA_BUCKET.get(payload.key);
        if (!object) return new Response('Not found', { status: 404 });
        const headers = new Headers();
        object.writeHttpMetadata(headers);
        headers.set('etag', object.httpEtag);
        headers.set('cache-control', 'private, max-age=0');
        return new Response(object.body, { headers });
      }

      return json({ error: 'Not found' }, 404, requestCors);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : 'Media worker error' }, 500, requestCors);
    }
  },
};
