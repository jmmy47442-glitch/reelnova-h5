import type { H3Event } from 'h3';
import type { AdminEpisode } from '~/types/admin';
import { d1All, hasD1Connection } from './cloudflare-d1';

interface EpisodeMediaRow {
  id: string;
  episode_no: number;
  title: string;
  duration_seconds: number;
  is_free: number;
  video_status: AdminEpisode['videoStatus'];
  thumbnail_url: string;
  media_asset_id: string | null;
  upload_id: string | null;
  source_file_name: string | null;
  source_size_bytes: number | null;
  source_object_key: string | null;
  asset_status: string | null;
  progress: number | null;
  error_message: string | null;
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
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await response.json().catch(() => ({})) as { error?: string } & T;
  if (!response.ok) throw createError({ statusCode: 502, statusMessage: payload.error || `Media worker request failed (${response.status})` });
  return payload;
};

export const listAdminEpisodes = async (event: H3Event, seriesId: string, _sync = true): Promise<AdminEpisode[]> => {
  const rows = await d1All<EpisodeMediaRow>(event, `SELECT e.id, e.episode_no, e.title, e.duration_seconds, e.is_free, e.video_status, e.thumbnail_url,
      a.id AS media_asset_id, u.id AS upload_id, a.source_file_name, a.source_size_bytes, a.source_object_key, a.status AS asset_status,
      0 AS progress, a.validation_error AS error_message
    FROM episodes e
    LEFT JOIN media_assets a ON a.id = e.active_media_asset_id OR (e.active_media_asset_id IS NULL AND a.id = (
      SELECT id FROM media_assets candidate WHERE candidate.episode_id = e.id AND candidate.deleted_at IS NULL ORDER BY candidate.created_at DESC LIMIT 1))
    LEFT JOIN media_upload_sessions u ON u.id = (SELECT id FROM media_upload_sessions candidate
      WHERE candidate.media_asset_id = a.id AND candidate.status IN ('created', 'uploading') ORDER BY candidate.created_at DESC LIMIT 1)
    WHERE e.series_id = ? AND e.deleted_at IS NULL ORDER BY e.episode_no`, [seriesId]);
  return rows.map((row) => ({
    id: row.id, episodeNo: row.episode_no, title: row.title, durationSeconds: Number(row.duration_seconds),
    isFree: Boolean(row.is_free), videoStatus: row.video_status,
    transcodeProgress: row.video_status === 'ready' ? 100 : Number(row.progress || 0), thumbnailUrl: row.thumbnail_url || '',
    mediaAssetId: row.media_asset_id, uploadId: row.upload_id, sourceFileName: row.source_file_name, sourceSizeBytes: row.source_size_bytes,
    errorMessage: row.error_message,
    previewUrl: row.source_object_key && row.video_status === 'ready'
      ? `/api/admin/media/${encodeURIComponent(row.media_asset_id || '')}/preview`
      : null,
  }));
};
