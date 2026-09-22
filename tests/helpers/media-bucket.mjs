import assert from 'node:assert/strict';

export const createBucket = () => {
  const objects = new Map();
  const uploads = new Map();
  let creates = 0;
  let aborts = 0;
  const withMetadata = (value) => ({
    ...value,
    etag: value.httpEtag.replace(/^"|"$/g, ''),
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
      async arrayBuffer() { return body.slice().buffer; },
      async json() { return JSON.parse(new TextDecoder().decode(bytes)); },
    });
  };
  return {
    get createCount() { return creates; },
    get abortCount() { return aborts; },
    async createMultipartUpload(key, options) {
      creates += 1;
      const uploadId = `r2-upload-${creates}`;
      const state = { key, uploadId, options, aborted: false, parts: new Map() };
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
        async uploadPart(partNumber, body) { state.parts.set(partNumber, new Uint8Array(await new Response(body).arrayBuffer())); return { partNumber, etag: `etag-${partNumber}` }; },
        async complete() {
          const bytes = new Uint8Array(Buffer.concat([...state.parts.entries()].sort((a,b) => a[0]-b[0]).map(([,part]) => part)));
          const object = {
            key, httpEtag: 'completed-etag', customMetadata: state.options.customMetadata,
            httpMetadata: state.options.httpMetadata, uploaded: new Date(), body: bytes, size: bytes.byteLength,
          };
          objects.set(key, object);
          uploads.delete(uploadId);
          return withMetadata(object);
        },
        async abort() { aborts += 1; uploads.delete(uploadId); },
      };
    },
    async put(key, body, options) {
      const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body;
      objects.set(key, { key, body: bytes, size: bytes.byteLength, httpEtag: `etag:${key}`, httpMetadata: options?.httpMetadata,
        customMetadata: options?.customMetadata || {}, uploaded: new Date() });
    },
    async get(key, options) {
      if (options?.onlyIf) {
        assert.ok(options.onlyIf.etagMatches, 'conditional reads require the raw object ETag');
        assert.ok(!options.onlyIf.etagMatches.includes('"'), 'R2 rejects quoted conditional ETags');
      }
      return objects.has(key) ? bodyObject(objects.get(key), options) : null;
    },
    async head(key) { return objects.has(key) ? withMetadata(objects.get(key)) : null; },
    async delete(key) { objects.delete(key); },
    async list() { return { objects: [], truncated: false }; },
  };
};

