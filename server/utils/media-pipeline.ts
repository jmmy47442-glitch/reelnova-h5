import type { H3Event } from 'h3';
import type { AdminEpisode } from '~/types/admin';
import { d1All, d1First, d1Run, hasD1Connection } from './cloudflare-d1';

interface EpisodeMediaRow {
  id: string;
  episode_no: number;
  title: string;
  duration_seconds: number;
  is_free: number;
  video_status: AdminEpisode['videoStatus'];
  thumbnail_url: string;
  media_asset_id: string | null;
  source_file_name: string | null;
  source_size_bytes: number | null;
  stream_uid: string | null;
  hls_url: string | null;
  asset_status: string | null;
  progress: number | null;
  error_message: string | null;
}

interface StreamVideo {
  uid: string;
  readyToStream?: boolean;
  status?: { state?: string; pctComplete?: string; errorReasonCode?: string; errorReasonText?: string };
  duration?: number;
  input?: { width?: number; height?: number };
  playback?: { hls?: string; dash?: string };
  thumbnail?: string;
  meta?: Record<string, string>;
}

const encoder = new TextEncoder();
const bytesToHex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

const signHex = async (value: string, secret: string) => {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return bytesToHex(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value))));
};

export const requireMediaPipeline = (event: H3Event) => {
  if (!hasD1Connection(event)) throw createError({ statusCode: 503, statusMessage: 'Cloudflare D1 is required for media uploads', data: { code: 'D1_NOT_CONFIGURED' } });
  const config = useRuntimeConfig(event);
  const workerUrl = String(config.cloudflareMediaWorkerUrl || '').replace(/\/$/, '');
  const secret = String(config.cloudflareMediaWorkerSecret || '');
  if (!workerUrl || !secret) throw createError({ statusCode: 503, statusMessage: 'Cloudflare media upload worker is not configured', data: { code: 'MEDIA_PIPELINE_NOT_CONFIGURED' } });
  return { workerUrl, secret };
};

export const mediaWorkerRequest = async <T>(event: H3Event, path: string, body: unknown, method = 'POST'): Promise<T> => {
  const { workerUrl, secret } = requireMediaPipeline(event);
  const rawBody = JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = await signHex(`${timestamp}.${rawBody}`, secret);
  const response = await fetch(`${workerUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-reelnova-timestamp': timestamp, 'x-reelnova-signature': signature },
    body: rawBody,
  });
  const payload = await response.json().catch(() => ({})) as { error?: string } & T;
  if (!response.ok) throw createError({ statusCode: 502, statusMessage: payload.error || `Media worker request failed (${response.status})` });
  return payload;
};

const streamApiRequest = async <T>(event: H3Event, path: string, options: RequestInit = {}): Promise<T> => {
  const config = useRuntimeConfig(event);
  const accountId = String(config.cloudflareAccountId || '');
  const apiToken = String(config.cloudflareApiToken || '');
  if (!accountId || !apiToken) throw createError({ statusCode: 503, statusMessage: 'Cloudflare Stream API is not configured', data: { code: 'STREAM_NOT_CONFIGURED' } });
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/stream${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${apiToken}`, 'content-type': 'application/json', ...(options.headers || {}) },
  });
  const payload = await response.json() as { success?: boolean; result?: T; errors?: Array<{ message?: string }> };
  if (!response.ok || !payload.success || !payload.result) {
    throw createError({ statusCode: 502, statusMessage: payload.errors?.[0]?.message || 'Cloudflare Stream request failed' });
  }
  return payload.result;
};

const percent = (value: unknown) => Math.max(0, Math.min(99, Math.round(Number.parseFloat(String(value || '0')) || 0)));

export const createStreamManifestUrl = (streamUid: string, token: string, hlsUrl?: string | null, customerCode?: string | null) => {
  const storedUrl = String(hlsUrl || '');
  if (storedUrl) return storedUrl.replace(`/${streamUid}/`, `/${token}/`);
  const code = String(customerCode || '');
  return code ? `https://customer-${code}.cloudflarestream.com/${token}/manifest/video.m3u8` : null;
};

export const createStreamThumbnailUrl = (
  streamUid: string,
  token: string,
  thumbnailUrl?: string | null,
  customerCode?: string | null,
  variant: 'cover' | 'backdrop' = 'cover',
) => {
  const storedUrl = String(thumbnailUrl || '');
  const code = String(customerCode || '');
  const base = storedUrl
    ? storedUrl.replace(`/${streamUid}/`, `/${token}/`)
    : code ? `https://customer-${code}.cloudflarestream.com/${token}/thumbnails/thumbnail.jpg` : '';
  if (!base) return null;
  const url = new URL(base);
  url.searchParams.set('time', '3s');
  url.searchParams.set('fit', 'crop');
  url.searchParams.set('width', variant === 'cover' ? '600' : '1600');
  url.searchParams.set('height', variant === 'cover' ? '900' : '900');
  return url.toString();
};

export const applyStreamStatus = async (event: H3Event, assetId: string, video: StreamVideo) => {
  const now = new Date().toISOString();
  const asset = await d1First<{ id: string; episode_id: string }>(event, 'SELECT id, episode_id FROM media_assets WHERE id = ?', [assetId]);
  if (!asset) return;
  const state = video.status?.state || (video.readyToStream ? 'ready' : 'processing');
  if (video.readyToStream || state === 'ready') {
    const width = Number(video.input?.width || 0);
    const height = Number(video.input?.height || 0);
    const validationError = !width || !height ? 'Stream did not report a valid video track' : null;
    if (validationError) {
      await d1Run(event, `UPDATE media_assets SET status = 'failed', validation_status = 'invalid', validation_error = ?, updated_at = ? WHERE id = ?`, [validationError, now, assetId]);
      await d1Run(event, `UPDATE transcode_jobs SET status = 'failed', error_code = 'INVALID_VIDEO_TRACK', error_message = ?, updated_at = ?, completed_at = ? WHERE media_asset_id = ? AND status <> 'ready'`, [validationError, now, now, assetId]);
      await d1Run(event, `UPDATE episodes SET video_status = 'failed', updated_at = ? WHERE id = ?`, [now, asset.episode_id]);
      return;
    }
    await d1Run(event, `UPDATE media_assets SET stream_uid = ?, width = ?, height = ?, duration_seconds = ?, has_video = 1,
      has_audio = 1, validation_status = 'valid', validation_error = NULL, hls_url = ?, dash_url = ?, thumbnail_url = ?,
      status = 'ready', updated_at = ? WHERE id = ?`, [video.uid, width, height, Number(video.duration || 0), video.playback?.hls || null, video.playback?.dash || null, video.thumbnail || null, now, assetId]);
    await d1Run(event, `UPDATE transcode_jobs SET provider_job_id = ?, status = 'ready', progress = 100, error_code = NULL,
      error_message = NULL, updated_at = ?, completed_at = ? WHERE media_asset_id = ? AND status <> 'cancelled'`, [video.uid, now, now, assetId]);
    await d1Run(event, `UPDATE episodes SET active_media_asset_id = ?, video_status = 'ready', duration_seconds = ?,
      thumbnail_url = COALESCE(?, thumbnail_url), updated_at = ? WHERE id = ?`, [assetId, Math.round(Number(video.duration || 0)), video.thumbnail || null, now, asset.episode_id]);
    await d1Run(event, `UPDATE series SET status = 'draft', updated_at = ?
      WHERE id = (SELECT series_id FROM episodes WHERE id = ?) AND status = 'processing'
        AND NOT EXISTS (SELECT 1 FROM episodes pending WHERE pending.series_id = series.id AND pending.deleted_at IS NULL AND pending.video_status <> 'ready')`,
    [now, asset.episode_id]);
    return;
  }
  if (state === 'error') {
    const message = video.status?.errorReasonText || 'Cloudflare Stream transcoding failed';
    await d1Run(event, `UPDATE media_assets SET status = 'failed', validation_status = 'invalid', validation_error = ?, updated_at = ? WHERE id = ?`, [message, now, assetId]);
    await d1Run(event, `UPDATE transcode_jobs SET provider_job_id = ?, status = 'failed', progress = 0, error_code = ?, error_message = ?,
      updated_at = ?, completed_at = ? WHERE media_asset_id = ? AND status <> 'cancelled'`, [video.uid, video.status?.errorReasonCode || 'STREAM_ERROR', message, now, now, assetId]);
    await d1Run(event, `UPDATE episodes SET video_status = 'failed', updated_at = ? WHERE id = ?`, [now, asset.episode_id]);
    return;
  }
  await d1Run(event, `UPDATE media_assets SET stream_uid = ?, status = 'processing', updated_at = ? WHERE id = ?`, [video.uid, now, assetId]);
  await d1Run(event, `UPDATE transcode_jobs SET provider_job_id = ?, status = 'processing', progress = ?, started_at = COALESCE(started_at, ?),
    updated_at = ? WHERE media_asset_id = ? AND status IN ('queued', 'processing')`, [video.uid, percent(video.status?.pctComplete), now, now, assetId]);
  await d1Run(event, `UPDATE episodes SET video_status = 'processing', updated_at = ? WHERE id = ?`, [now, asset.episode_id]);
};

export const syncStreamAsset = async (event: H3Event, assetId: string, streamUid: string) => {
  const video = await streamApiRequest<StreamVideo>(event, `/${encodeURIComponent(streamUid)}`);
  await applyStreamStatus(event, assetId, video);
};

export const listAdminEpisodes = async (event: H3Event, seriesId: string, sync = true): Promise<AdminEpisode[]> => {
  const processing = sync ? await d1All<{ id: string; stream_uid: string }>(event, `SELECT id, stream_uid FROM media_assets
    WHERE stream_uid IS NOT NULL AND status = 'processing' AND episode_id IN (SELECT id FROM episodes WHERE series_id = ?)
    ORDER BY updated_at ASC LIMIT 8`, [seriesId]) : [];
  await Promise.all(processing.map((asset) => syncStreamAsset(event, asset.id, asset.stream_uid).catch(() => undefined)));
  const rows = await d1All<EpisodeMediaRow>(event, `SELECT e.id, e.episode_no, e.title, e.duration_seconds, e.is_free, e.video_status, e.thumbnail_url,
      a.id AS media_asset_id, a.source_file_name, a.source_size_bytes, a.stream_uid, a.hls_url, a.status AS asset_status,
      j.progress, COALESCE(j.error_message, a.validation_error) AS error_message
    FROM episodes e
    LEFT JOIN media_assets a ON a.id = e.active_media_asset_id OR (e.active_media_asset_id IS NULL AND a.id = (
      SELECT id FROM media_assets candidate WHERE candidate.episode_id = e.id AND candidate.deleted_at IS NULL ORDER BY candidate.created_at DESC LIMIT 1))
    LEFT JOIN transcode_jobs j ON j.id = (SELECT id FROM transcode_jobs candidate WHERE candidate.media_asset_id = a.id ORDER BY candidate.created_at DESC LIMIT 1)
    WHERE e.series_id = ? AND e.deleted_at IS NULL ORDER BY e.episode_no`, [seriesId]);
  const config = useRuntimeConfig(event);
  const customerCode = String(config.cloudflareStreamCustomerCode || '');
  return rows.map((row) => ({
    id: row.id, episodeNo: row.episode_no, title: row.title, durationSeconds: Number(row.duration_seconds),
    isFree: Boolean(row.is_free), videoStatus: row.video_status,
    transcodeProgress: row.video_status === 'ready' ? 100 : Number(row.progress || 0), thumbnailUrl: row.thumbnail_url || '',
    mediaAssetId: row.media_asset_id, sourceFileName: row.source_file_name, sourceSizeBytes: row.source_size_bytes,
    errorMessage: row.error_message,
    previewUrl: row.stream_uid && row.video_status === 'ready' && (row.hls_url || customerCode)
      ? `/api/admin/media/${encodeURIComponent(row.media_asset_id || '')}/preview`
      : null,
  }));
};

export const createStreamPlaybackToken = async (event: H3Event, uid: string) => {
  const token = await streamApiRequest<{ token: string }>(event, `/${encodeURIComponent(uid)}/token`, {
    method: 'POST', body: JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 10 * 60 }),
  });
  return token.token;
};

export type { StreamVideo };
