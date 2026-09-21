import { createHmac } from 'node:crypto';

export const checkMediaHealth = async (env) => {
  const base = String(env.CLOUDFLARE_MEDIA_WORKER_URL || '').replace(/\/$/, '');
  const secret = env.CLOUDFLARE_MEDIA_WORKER_SECRET;
  if (!base || !secret) throw new Error('Missing CLOUDFLARE_MEDIA_WORKER_URL / CLOUDFLARE_MEDIA_WORKER_SECRET');
  const timestamp = String(Math.floor(Date.now() / 1000));
  const body = '{}';
  const signature = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  const response = await fetch(`${base}/health`, {
    method: 'POST', body, signal: AbortSignal.timeout(10000),
    headers: { 'content-type': 'application/json', 'x-reelnova-timestamp': timestamp, 'x-reelnova-signature': signature },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ready !== true || payload.delivery !== 'r2-hls' || payload.transcoderReady !== true) {
    const detail = payload.transcoderError ? `: ${payload.transcoderError}` : '';
    throw new Error(`R2/HLS media pipeline health check failed (HTTP ${response.status})${detail}; deploy the current media and transcode Workers and check their bindings and secrets`);
  }
};
