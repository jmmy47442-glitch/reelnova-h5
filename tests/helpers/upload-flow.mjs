import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import worker from '../../workers/media-worker.mjs';
import { inspectStoredMp4 } from '../../shared/direct-mp4.mjs';
import { createBucket } from './media-bucket.mjs';

// Execute the real page uploader, API handlers, SQL and signed Worker routes.
// Only browser transport and the external storage/FFmpeg bindings are replaced.
export const uploadFlow = (liveConfig = null) => {
  const seriesId = liveConfig?.seriesId || 'series-test';
  const db = new DatabaseSync(':memory:');
  const migrationDir = new URL('../../migrations/', import.meta.url);
  for (const name of readdirSync(migrationDir).filter(n => n.endsWith('.sql')).sort()) {
    db.exec(readFileSync(new URL(name, migrationDir), 'utf8'));
  }
  db.exec("INSERT INTO series (id, slug, title, free_episode_count, created_at, updated_at) VALUES ('series-test', 'series-test', 'Upload test', 1, 'now', 'now')");
  const bucket = createBucket();
  const jobs = [];
  const env = { MEDIA_BUCKET: bucket, MEDIA_WORKER_SECRET: 'upload-flow-secret', TRANSCODE_SERVICE: {
    fetch: async request => {
      const body = await request.json(); jobs.push(body);
      return Response.json({ workflowId: body.jobId });
    },
  } };
  const workerBase = liveConfig?.workerUrl || 'https://media.test';
  const workerSecret = liveConfig?.workerSecret || env.MEDIA_WORKER_SECRET;
  const transport = request => liveConfig ? fetch(request) : worker.fetch(request, env);
  const log = [];
  const faults = { loseCompletion: false, failPart: 0, beforeComplete: null, afterFinalize: null, stateError: null };
  const d1 = liveConfig?.d1 || {
    hasD1Connection: () => true,
    d1All: async (_e, sql, p = []) => db.prepare(sql).all(...p),
    d1First: async (_e, sql, p = []) => db.prepare(sql).get(...p) || null,
    d1Run: async (_e, sql, p = []) => db.prepare(sql).run(...p),
    d1Batch: async (_e, statements) => {
      db.exec('BEGIN');
      try {
        const results = statements.map(({ sql, params = [] }) => {
          const statement = db.prepare(sql);
          return /^\s*SELECT/i.test(sql) ? { results: statement.all(...params) } : statement.run(...params);
        });
        db.exec('COMMIT'); return results;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
  };
  const createError = input => Object.assign(new Error(input.statusMessage), input);
  const imports = { './cloudflare-d1': d1, '~/server/utils/cloudflare-d1': d1,
    './admin-audit': { recordAdminAudit: async () => {} },
    '~/server/utils/admin-audit': { recordAdminAudit: async () => {} },
    '~/server/utils/response': { ok: data => ({ data }) },
    './system-config': {},
  };
  const load = file => {
    const exports = {};
    const source = readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
    const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
    runInNewContext(code, {
      exports, require: name => { assert.ok(imports[name], `Unexpected import ${name}`); return imports[name]; },
      crypto, TextEncoder, URL, AbortSignal, createError, setTimeout,
      defineEventHandler: fn => fn, getRouterParam: (event, name) => event.params?.[name],
      getQuery: event => event.query || {}, readBody: async event => event.body,
      readRawBody: async event => JSON.stringify(event.body),
      getHeader: (event, key) => event.headers?.[key], setHeader: () => {},
      sendRedirect: (_event, url) => url,
      useRuntimeConfig: () => ({ cloudflareMediaWorkerUrl: workerBase, cloudflareMediaWorkerSecret: workerSecret }),
      fetch: async (url, options) => {
        log.push(new URL(url).pathname);
        const response = await transport(new Request(url, options));
        if (faults.afterFinalize && url.endsWith('/complete')) await faults.afterFinalize();
        if (faults.loseCompletion && url.endsWith('/complete')) return Response.json({ error: 'response lost after commit' }, { status: 502 });
        return response;
      },
    });
    return exports;
  };
  const pipeline = load('server/utils/media-pipeline.ts');
  imports['./media-pipeline'] = imports['~/server/utils/media-pipeline'] = pipeline;
  imports['./episode-order'] = load('server/utils/episode-order.ts');
  const managed = load('server/utils/managed-content.ts');
  imports['~/server/utils/managed-content'] = managed;
  const state = load('server/utils/media-upload-state.ts');
  imports['~/server/utils/media-upload-state'] = state;
  imports['~/server/utils/internal-worker-auth'] = load('server/utils/internal-worker-auth.ts');
  const create = load('server/api/admin/series/[id]/episodes/uploads.post.ts').default;
  const complete = load('server/api/admin/media/uploads/[uploadId]/complete.post.ts').default;
  const get = load('server/api/admin/media/uploads/[uploadId].get.ts').default;
  const cancel = load('server/api/admin/media/uploads/[uploadId].delete.ts').default;
  const progress = load('server/api/admin/media/uploads/[uploadId]/progress.patch.ts').default;
  const preview = load('server/api/admin/media/[assetId]/preview.get.ts').default;
  const retry = load('server/api/admin/media/[assetId]/retry.post.ts').default;
  const callback = load('server/api/internal/media/transcode.post.ts').default;
  const api = {
    createEpisodeUpload: async (id, body) => (await create({ params: { id }, body })).data,
    getEpisodeUpload: async uploadId => {
      if (faults.stateError) throw faults.stateError;
      return (await get({ params: { uploadId } })).data;
    },
    completeEpisodeUpload: async (uploadId, parts) => {
      if (faults.beforeComplete) await faults.beforeComplete(uploadId);
      return (await complete({ params: { uploadId }, body: { parts } })).data;
    },
    cancelEpisodeUpload: async uploadId => (await cancel({ params: { uploadId } })).data,
    reportUploadProgress: async (uploadId, uploadedBytes) => (await progress({ params: { uploadId }, body: { uploadedBytes } })).data,
    retryTranscode: async assetId => (await retry({ params: { assetId } })).data,
  };
  const storage = new Map();
  const localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value),
    removeItem: key => storage.delete(key), key: index => [...storage.keys()][index], get length() { return storage.size; } };
  class XMLHttpRequest {
    upload = {}; headers = {}; status = 0; stopped = false;
    open(method, url) { this.method = method; this.url = url; }
    setRequestHeader(name, value) { this.headers[name] = value; }
    abort() { this.stopped = true; this.onabort?.(); this.onloadend?.(); }
    async send(body) {
      log.push(new URL(this.url).pathname);
      try {
        const response = faults.failPart-- > 0 ? new Response('temporary', { status: 503 })
          : await transport(new Request(this.url, { method: this.method, headers: this.headers, body, signal: AbortSignal.timeout(60_000) }));
        if (this.stopped) return;
        this.status = response.status; this.responseText = await response.text();
        this.upload.onprogress?.({ loaded: body.size }); this.onload?.();
      } catch { this.onerror?.(); }
      finally { this.onloadend?.(); }
    }
  }
  const refs = {};
  for (const key of ['uploadFinalizing', 'uploadCancelled', 'uploadLabel', 'uploadSpeed', 'uploadUploadedBytes', 'uploadTotalBytes', 'uploadProgress', 'activeUploadSessionId']) refs[key] = { value: null };
  Object.assign(refs, { uploading: { value: true }, selectedSeries: { value: { id: seriesId } },
    episodes: { value: [] }, cancellingUploadIds: { value: [] } });
  const pageSource = readFileSync(new URL('../../pages/admin/series.vue', import.meta.url), 'utf8');
  const section = pageSource.slice(pageSource.indexOf('interface ResumeState'), pageSource.indexOf('const startTranscode ='));
  const code = ts.transpileModule(section, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const client = runInNewContext(`(function () { let activeUploadResumeKey = '', activeUploadIdempotencyKey = ''; const activeUploadRequests = new Set(); const uploadPartConcurrency = 3; ${code}\nreturn { uploadOne, readResume, resumeKey, cancelUpload }; })()`, {
    ...refs, api, localStorage, crypto, performance, XMLHttpRequest, DOMException, inspectStoredMp4,
    loadEpisodes: async () => { refs.episodes.value = await pipeline.listAdminEpisodes({}, seriesId); },
    mediaErrorMessage: message => message,
  });
  return { db, bucket, api, state, managed, callback, env, log, faults, client, refs, storage,
    upload: (file, no = 1) => client.uploadOne(file, no, 0, file.size),
    preview: (assetId, query = {}) => preview({ params: { assetId }, query }),
    listEpisodes: () => pipeline.listAdminEpisodes({}, seriesId),
    transport,
    fetchMedia: url => transport(new Request(url, { signal: AbortSignal.timeout(30_000) })),
  };
};

export const videoFixture = (name = 'compatible') => new File([
  readFileSync(new URL(`../fixtures/media/${name}.mp4`, import.meta.url)),
], `${name}.mp4`, { type: 'video/mp4', lastModified: 1 });
