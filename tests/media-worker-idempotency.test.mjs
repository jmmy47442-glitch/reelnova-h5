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

const signedRequest = async (path, body) => {
  const rawBody = JSON.stringify(body);
  const { timestamp, signature } = await sign(rawBody);
  return new Request(`https://media.example.test${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-reelnova-timestamp': timestamp, 'x-reelnova-signature': signature },
    body: rawBody,
  });
};

const createBucket = () => {
  const objects = new Map();
  const uploads = new Map();
  let creates = 0;
  const bodyObject = (value) => ({
    ...value,
    async json() { return JSON.parse(value.body); },
  });
  return {
    get createCount() { return creates; },
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
            uploaded: new Date(), body: '',
          };
          objects.set(key, object);
          uploads.delete(uploadId);
          return object;
        },
        async abort() { uploads.delete(uploadId); },
      };
    },
    async put(key, body, options) {
      objects.set(key, { key, body, httpEtag: `etag:${key}`, customMetadata: options?.customMetadata || {}, uploaded: new Date() });
    },
    async get(key) { return objects.has(key) ? bodyObject(objects.get(key)) : null; },
    async head(key) { return objects.get(key) || null; },
    async delete(key) { objects.delete(key); },
    async list() { return { objects: [], truncated: false }; },
  };
};

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
