import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('../workers/transcode-worker.mjs', import.meta.url), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const exports = {};
const callbacks = [];
runInNewContext(code, {
  exports, TextEncoder, Request, Response, URL, Error, crypto,
  fetch: async (_url, options) => { callbacks.push(JSON.parse(options.body)); return new Response('{}'); },
  require: name => {
    if (name === '@cloudflare/containers') return { Container: class {}, getContainer: binding => binding };
    if (name === 'cloudflare:workers') return { WorkflowEntrypoint: class { constructor(_ctx, env) { this.env = env; } } };
    throw new Error(`Unexpected import ${name}`);
  },
});
const health = workflow => exports.default.fetch(new Request('https://transcoder.internal/health'), {
  MEDIA_BUCKET: { list: async () => ({ objects: [] }) },
  MEDIA_TRANSCODE_WORKFLOW: workflow,
});

test('health reads the workflow without creating a transcode task', async () => {
  let reads = 0;
  const response = await health({
    create: () => assert.fail('Health must never create an instance'),
    get: async id => {
      assert.equal(id, 'reelnova-health-probe');
      return { status: async () => { reads++; throw new Error('(instance.not_found) Instance does not exist'); } };
    },
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ready, true);
  assert.equal(reads, 1);
});

test('health rejects missing workflow resources, bindings, and unexpected errors', async () => {
  for (const message of ['(workflow.not_found) Workflow does not exist', 'Permission denied', 'Connection failed']) {
    for (const failAtGet of [true, false]) {
      const response = await health({ get: async () => {
        if (failAtGet) throw new Error(message);
        return { status: async () => { throw new Error(message); } };
      } });
      assert.equal(response.status, 500);
      assert.equal((await response.json()).error, message);
    }
  }
  const missing = await health(undefined);
  assert.equal(missing.status, 500);
  assert.match((await missing.json()).error, /binding is missing/);
});

test('workflow preserves plain-text container infrastructure errors and rejects incomplete success', async () => {
  const assetId = 'media_11111111-1111-4111-8111-111111111111';
  const payload = { assetId, jobId: `transcode_${assetId}`, sourceObjectKey: `originals/series_1/episode_1/${assetId}/video.mp4`,
    sourceEtag: 'original-etag', buildId: '22222222-2222-4222-8222-222222222222' };
  for (const [status, raw, expected] of [
    [500, 'Failed to start container: There is no container application assigned to this Durable Object namespace', /no container application/],
    [200, '{}', /incomplete result/],
  ]) {
    callbacks.length = 0;
    const workflow = new exports.MediaTranscodeWorkflow({}, {
      MEDIA_TRANSCODER: { fetch: async () => new Response(raw, { status }) },
      APP_BASE_URL: 'https://app.test', MEDIA_WORKER_SECRET: 'test-secret',
    });
    const result = await workflow.run({ payload }, { do: async (_name, _options, run) => run() });
    assert.equal(result.status, 'failed');
    assert.match(result.errorMessage, expected);
    assert.equal(callbacks.at(-1).status, 'failed');
    assert.match(callbacks.at(-1).errorMessage, expected);
    assert.equal(callbacks.some(callback => callback.status === 'ready'), false);
  }
});
