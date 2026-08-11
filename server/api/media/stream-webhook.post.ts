import { applyStreamStatus, type StreamVideo } from '~/server/utils/media-pipeline';
import { d1First } from '~/server/utils/cloudflare-d1';

const encoder = new TextEncoder();
const sign = async (value: string, secret: string) => {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
};
const equal = (left: string, right: string) => {
  if (left.length !== right.length) return false;
  let result = 0;
  for (let index = 0; index < left.length; index += 1) result |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return result === 0;
};

export default defineEventHandler(async (event) => {
  const secret = String(useRuntimeConfig(event).cloudflareStreamWebhookSecret || '');
  if (!secret) throw createError({ statusCode: 503, statusMessage: 'Stream webhook is not configured' });
  const rawBody = await readRawBody(event) || '';
  const header = getHeader(event, 'webhook-signature') || '';
  const timestamp = header.match(/(?:^|,)time=([^,]+)/)?.[1] || '';
  const signature = header.match(/(?:^|,)sig1=([^,]+)/)?.[1] || '';
  if (!/^\d+$/.test(timestamp) || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300
    || !equal(signature, await sign(`${timestamp}.${rawBody}`, secret))) {
    throw createError({ statusCode: 401, statusMessage: 'Invalid Stream webhook signature' });
  }
  const video = JSON.parse(rawBody) as StreamVideo;
  const assetId = String(video.meta?.assetId || '');
  const asset = assetId
    ? await d1First<{ id: string }>(event, 'SELECT id FROM media_assets WHERE id = ?', [assetId])
    : await d1First<{ id: string }>(event, 'SELECT id FROM media_assets WHERE stream_uid = ?', [video.uid]);
  if (asset) await applyStreamStatus(event, asset.id, video);
  return { ok: true };
});
