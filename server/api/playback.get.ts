import { seriesList } from '~/data/mock';
import { ok } from '~/server/utils/response';
import { d1First, getVisitorId } from '~/server/utils/cloudflare-d1';

const sign = async (value: string, secret: string) => {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value)));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
};

export default defineEventHandler(async (event) => {
  const query = getQuery(event);
  const series = seriesList.find((item) => item.id === query.seriesId);
  const episode = series?.episodes.find((item) => item.episodeNo === Number(query.episodeNo));
  if (!series || !episode) throw createError({ statusCode: 404, statusMessage: 'Episode not found' });
  const visitorId = getVisitorId(event);
  const sessionId = String(query.sessionId || '');
  if (!sessionId || sessionId.length > 100) throw createError({ statusCode: 400, statusMessage: 'Playback session is required' });
  if (!episode.isFree) {
    const entitlement = await d1First<{ status: string }>(event, "SELECT status FROM entitlements WHERE visitor_id = ? AND series_id = ? AND status = 'granted'", [visitorId, series.id]);
    if (!entitlement) throw createError({ statusCode: 403, statusMessage: 'Entitlement required' });
  }
  const config = useRuntimeConfig(event);
  const mediaBaseUrl = String(config.cloudflareMediaBaseUrl || '').replace(/\/$/, '');
  const signingSecret = String(config.cloudflareMediaSigningSecret || '');
  if (!mediaBaseUrl || !signingSecret) throw createError({ statusCode: 503, statusMessage: 'Cloudflare media delivery is not configured' });
  const expires = Math.floor(Date.now() / 1000) + 10 * 60;
  const path = `/hls/${series.id}/${episode.episodeNo}/master.m3u8`;
  const signature = await sign(`${path}:${visitorId}:${expires}`, signingSecret);
  const trackingSignature = await sign(`track:${visitorId}:${sessionId}:${series.id}:${episode.episodeNo}:${expires}`, signingSecret);
  return ok({ authorized: true, signedUrl: `${mediaBaseUrl}${path}?visitor=${encodeURIComponent(visitorId)}&expires=${expires}&signature=${signature}`, expiresAt: new Date(expires * 1000).toISOString(), trackingToken: `${expires}.${trackingSignature}` });
});
