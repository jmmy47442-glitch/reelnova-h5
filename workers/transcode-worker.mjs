import { Container, getContainer } from '@cloudflare/containers';
import { WorkflowEntrypoint } from 'cloudflare:workers';

const encoder = new TextEncoder();
const assetPattern = /^media_[0-9a-f-]{36}$/i;
const jobPattern = /^transcode_media_[0-9a-f-]{36}$/i;
const objectPattern = /^originals\/[a-z0-9_-]{2,100}\/[a-z0-9_-]{2,100}\/[a-z0-9_-]{2,100}\/[a-z0-9_.-]{2,160}$/i;

const bytesToHex = bytes => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
const hmac = async (value, secret) => {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
};

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
});

const errorText = error => (error instanceof Error ? error.message : 'Video transcode failed').slice(0, 1000);

const notifyApplication = async (env, payload) => {
  if (!env.APP_BASE_URL || !env.MEDIA_WORKER_SECRET) throw new Error('Application callback is not configured');
  const rawBody = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = bytesToHex(await hmac(`${timestamp}.${rawBody}`, env.MEDIA_WORKER_SECRET));
  const response = await fetch(`${String(env.APP_BASE_URL).replace(/\/$/, '')}/api/internal/media/transcode`, {
    method: 'POST', body: rawBody,
    headers: { 'content-type': 'application/json', 'x-reelnova-timestamp': timestamp, 'x-reelnova-signature': signature },
  });
  if (!response.ok) throw new Error(`Application transcode callback failed (${response.status}): ${await response.text()}`);
};

const validateJob = (body) => {
  const job = {
    jobId: String(body?.jobId || ''), assetId: String(body?.assetId || ''),
    sourceObjectKey: String(body?.sourceObjectKey || ''), sourceEtag: String(body?.sourceEtag || ''),
    buildId: String(body?.buildId || ''), restart: body?.restart === true,
  };
  if (!jobPattern.test(job.jobId) || !assetPattern.test(job.assetId) || !objectPattern.test(job.sourceObjectKey)
    || !/^[a-zA-Z0-9_-]{8,160}$/.test(job.sourceEtag) || !/^[0-9a-f-]{36}$/i.test(job.buildId)) {
    throw new Error('Invalid transcode job request');
  }
  return job;
};

export class MediaTranscodeContainer extends Container {
  defaultPort = 8080;
  requiredPorts = [8080];
  sleepAfter = '2m';
  pingEndpoint = 'ping';
  envVars = {
    AWS_ACCESS_KEY_ID: this.env.R2_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY: this.env.R2_SECRET_ACCESS_KEY,
    R2_ACCOUNT_ID: this.env.R2_ACCOUNT_ID,
    R2_BUCKET_NAME: this.env.R2_BUCKET_NAME,
  };
}

export class MediaTranscodeWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const job = validateJob(event.payload);
    await step.do('mark transcode processing', { retries: { limit: 8, delay: '10 seconds', backoff: 'exponential' } },
      () => notifyApplication(this.env, { jobId: job.jobId, assetId: job.assetId, status: 'processing', progress: 5 }));

    let result;
    try {
      result = await step.do('run ffmpeg container', {
        retries: { limit: 2, delay: '30 seconds', backoff: 'exponential' }, timeout: '8 hours',
      }, async () => {
        const container = getContainer(this.env.MEDIA_TRANSCODER, job.jobId);
        const response = await container.fetch(new Request('http://container/transcode', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(job),
        }));
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || `FFmpeg container failed (${response.status})`);
        return body;
      });
    } catch (error) {
      const message = errorText(error);
      await step.do('record transcode failure', { retries: { limit: 10, delay: '15 seconds', backoff: 'exponential' } },
        () => notifyApplication(this.env, { jobId: job.jobId, assetId: job.assetId, status: 'failed', progress: 0, errorMessage: message }));
      return { status: 'failed', errorMessage: message };
    }

    await step.do('publish transcode completion', { retries: { limit: 10, delay: '15 seconds', backoff: 'exponential' } },
      () => notifyApplication(this.env, {
        jobId: job.jobId, assetId: job.assetId, status: 'ready', progress: 100,
        sourceEtag: job.sourceEtag, hlsPrefix: result.prefix, media: result.media, renditions: result.renditions,
      }));
    return { status: 'ready', hlsPrefix: result.prefix, renditions: result.renditions?.length || 0 };
  }
}

const startJob = async (env, body) => {
  const job = validateJob(body);
  const object = await env.MEDIA_BUCKET.head(job.sourceObjectKey);
  if (!object || object.customMetadata?.assetId !== job.assetId || object.etag !== job.sourceEtag) {
    throw new Error('Source video is missing, changed, or owned by another asset');
  }

  let instance;
  try {
    instance = await env.MEDIA_TRANSCODE_WORKFLOW.create({ id: job.jobId, params: job });
  } catch (error) {
    try { instance = await env.MEDIA_TRANSCODE_WORKFLOW.get(job.jobId); }
    catch { throw error; }
    const current = await instance.status();
    if (job.restart && ['complete', 'errored', 'terminated'].includes(current.status)) await instance.restart();
  }
  return { jobId: job.jobId, workflowId: instance.id, status: await instance.status() };
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (request.method === 'POST' && url.pathname === '/jobs') return json(await startJob(env, await request.json()));
      if (request.method === 'GET' && url.pathname === '/health') {
        await env.MEDIA_BUCKET.list({ limit: 1 });
        return json({ ready: true, engine: 'cloudflare-containers-ffmpeg' });
      }
      return json({ error: 'Not found' }, 404);
    } catch (error) { return json({ error: errorText(error) }, 500); }
  },
};
