import assert from 'node:assert/strict';
import test from 'node:test';
import worker from '../workers/media-worker.mjs';

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

const createBucket = () => {
  const objects = new Map();
  const uploads = new Map();
  let creates = 0;
  let aborts = 0;
  const withMetadata = (value) => ({
    ...value,
    writeHttpMetadata(headers) {
      if (value.httpMetadata?.contentType) headers.set('content-type', value.httpMetadata.contentType);
    },
  });
  const bodyObject = (value, options) => {
    const bytes = typeof value.body === 'string' ? new TextEncoder().encode(value.body) : value.body;
    const range = options?.range;
    const body = range ? bytes.slice(range.offset, range.offset + range.length) : bytes;
    return withMetadata({
      ...value,
      body,
      async json() { return JSON.parse(new TextDecoder().decode(bytes)); },
    });
  };
  return {
    get createCount() { return creates; },
    get abortCount() { return aborts; },
    async createMultipartUpload(key, options) {
      creates += 1;
      const uploadId = `r2-upload-${creates}`;
      const state = { key, uploadId, options, aborted: false };
      uploads.set(uploadId, state);
      return {
        uploadId,
        async abort() { state.aborted = true; },
      };
    },
    resumeMultipartUpload(key, uploadId) {
      const state = uploads.get(uploadId);
      if (!state || state.key !== key || state.aborted) throw new Error('No such upload');
      return {
        async uploadPart(partNumber) { return { partNumber, etag: `etag-${partNumber}` }; },
        async complete() {
          const object = {
            key, httpEtag: 'completed-etag', customMetadata: state.options.customMetadata,
            httpMetadata: state.options.httpMetadata, uploaded: new Date(), body: new Uint8Array(), size: 0,
          };
          objects.set(key, object);
          uploads.delete(uploadId);
          return object;
        },
        async abort() { aborts += 1; uploads.delete(uploadId); },
      };
    },
    async put(key, body, options) {
      const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body;
      objects.set(key, { key, body: bytes, size: bytes.byteLength, httpEtag: `etag:${key}`, httpMetadata: options?.httpMetadata,
        customMetadata: options?.customMetadata || {}, uploaded: new Date() });
    },
    async get(key, options) { return objects.has(key) ? bodyObject(objects.get(key), options) : null; },
    async head(key) { return objects.has(key) ? withMetadata(objects.get(key)) : null; },
    async delete(key) { objects.delete(key); },
    async list() { return { objects: [], truncated: false }; },
  };
};

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

test('repeated upload creation and completion reuse R2 and Stream resources', async () => {
  const bucket = createBucket();
  const videos = [];
  let streamCopies = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    if (url.hostname !== 'api.cloudflare.com') return originalFetch(input, options);
    if (url.pathname.endsWith('/stream/copy')) {
      streamCopies += 1;
      const request = JSON.parse(String(options.body));
      const video = { uid: `stream-${streamCopies}`, creator: request.creator, created: new Date().toISOString() };
      videos.push(video);
      return Response.json({ success: true, result: video });
    }
    if (url.pathname.endsWith('/stream')) {
      const creator = url.searchParams.get('creator');
      return Response.json({ success: true, result: videos.filter((video) => !creator || video.creator === creator) });
    }
    throw new Error(`Unexpected Cloudflare request: ${url}`);
  };

  try {
    const env = {
      MEDIA_BUCKET: bucket,
      MEDIA_WORKER_SECRET: secret,
      CLOUDFLARE_ACCOUNT_ID: 'account-id',
      CLOUDFLARE_API_TOKEN: 'api-token',
      PUBLIC_BASE_URL: 'https://media.example.test',
      APP_ORIGINS: '',
    };
    const creation = {
      idempotencyKey: 'upload:11111111-1111-4111-8111-111111111111',
      sessionId: 'upload_session_1',
      completionKey: 'r2:upload_session_1',
      streamIdempotencyKey: 'reelnova:upload:upload_session_1',
      objectKey: 'originals/series/episode/asset/video.mp4',
      contentType: 'video/mp4',
      fileSizeBytes: 1024,
      metadata: { assetId: 'asset_1' },
    };
    const first = await (await worker.fetch(await signedRequest('/uploads', creation), env)).json();
    const second = await (await worker.fetch(await signedRequest('/uploads', creation), env)).json();
    assert.equal(first.uploadId, second.uploadId);
    assert.equal(bucket.createCount, 1);

    const completion = {
      ...creation,
      uploadId: first.uploadId,
      parts: [{ partNumber: 1, etag: 'part-etag' }],
    };
    const firstCompletion = await (await worker.fetch(await signedRequest(`/uploads/${first.uploadId}/complete`, completion), env)).json();
    const secondCompletion = await (await worker.fetch(await signedRequest(`/uploads/${first.uploadId}/complete`, completion), env)).json();
    assert.equal(firstCompletion.streamUid, secondCompletion.streamUid);
    assert.equal(streamCopies, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
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

test('signed server requests can mint short-lived Stream tokens', async () => {
  const originalFetch = globalThis.fetch;
  let tokenRequest;
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    if (url.hostname !== 'api.cloudflare.com') return originalFetch(input, options);
    tokenRequest = { url, body: JSON.parse(String(options.body)) };
    return Response.json({ success: true, result: { token: 'signed-stream-token' } });
  };

  try {
    const env = {
      MEDIA_BUCKET: createBucket(),
      MEDIA_WORKER_SECRET: secret,
      CLOUDFLARE_ACCOUNT_ID: 'account-id',
      CLOUDFLARE_API_TOKEN: 'api-token',
      PUBLIC_BASE_URL: 'https://media.example.test',
      APP_ORIGINS: '',
    };
    const uid = '91b12e3e2084c38e41cce9f9a480e552';
    const response = await worker.fetch(await signedRequest('/stream/token', { uid, exp: Math.floor(Date.now() / 1000) + 600 }), env);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { token: 'signed-stream-token' });
    assert.equal(tokenRequest.url.pathname, `/client/v4/accounts/account-id/stream/${uid}/token`);
    assert.ok(tokenRequest.body.exp > Math.floor(Date.now() / 1000));

    const invalid = await worker.fetch(await signedRequest('/stream/token', { uid: '../other-video' }), env);
    assert.equal(invalid.status, 400);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('application-validated playback grants can mint Stream tokens without the upload secret', async () => {
  const originalFetch = globalThis.fetch;
  let validationRequests = 0;
  let tokenRequests = 0;
  const uid = '91b12e3e2084c38e41cce9f9a480e552';
  const exp = Math.floor(Date.now() / 1000) + 600;
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    if (url.hostname === 'app.example.test' && url.pathname === '/api/internal/media/playback-grant') {
      validationRequests += 1;
      const body = JSON.parse(String(options.body));
      if (body.grant !== 'valid-grant') return Response.json({ message: 'Unauthorized' }, { status: 401 });
      return Response.json({ data: { authorized: true, uid: body.uid, expires: body.exp } });
    }
    if (url.hostname === 'api.cloudflare.com') {
      tokenRequests += 1;
      return Response.json({ success: true, result: { token: 'grant-stream-token' } });
    }
    return originalFetch(input, options);
  };

  try {
    const env = {
      MEDIA_BUCKET: createBucket(),
      MEDIA_WORKER_SECRET: secret,
      CLOUDFLARE_ACCOUNT_ID: 'account-id',
      CLOUDFLARE_API_TOKEN: 'api-token',
      APP_BASE_URL: 'https://app.example.test',
      PUBLIC_BASE_URL: 'https://media.example.test',
      APP_ORIGINS: '',
    };
    const valid = new Request('https://media.example.test/stream/token', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ uid, exp, grant: 'valid-grant' }),
    });
    const validResponse = await worker.fetch(valid, env);
    assert.equal(validResponse.status, 200);
    assert.deepEqual(await validResponse.json(), { token: 'grant-stream-token' });

    const forged = new Request('https://media.example.test/stream/token', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ uid, exp, grant: 'forged-grant' }),
    });
    const forgedResponse = await worker.fetch(forged, env);
    assert.equal(forgedResponse.status, 401);
    assert.equal(validationRequests, 2);
    assert.equal(tokenRequests, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
