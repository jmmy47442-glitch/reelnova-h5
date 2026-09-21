import { d1Batch, d1First } from '~/server/utils/cloudflare-d1';
import { verifyMediaWorkerRequest } from '~/server/utils/internal-worker-auth';

interface TranscodeCallback {
  jobId?: unknown;
  assetId?: unknown;
  status?: unknown;
  progress?: unknown;
  sourceEtag?: unknown;
  hlsPrefix?: unknown;
  errorMessage?: unknown;
  media?: { width?: unknown; height?: unknown; durationSeconds?: unknown; hasVideo?: unknown; hasAudio?: unknown };
  renditions?: unknown;
}

export default defineEventHandler(async (event) => {
  const rawBody = await readRawBody(event, 'utf8') || '';
  if (!await verifyMediaWorkerRequest(event, rawBody)) {
    throw createError({ statusCode: 401, statusMessage: 'Invalid transcode callback signature' });
  }
  const body = JSON.parse(rawBody) as TranscodeCallback;
  const jobId = String(body.jobId || '');
  const assetId = String(body.assetId || '');
  const status = String(body.status || '');
  const progress = Math.max(0, Math.min(100, Math.round(Number(body.progress) || 0)));
  if (!/^transcode_media_[0-9a-f-]{36}$/i.test(jobId) || !/^media_[0-9a-f-]{36}$/i.test(assetId)
    || !['processing', 'ready', 'failed'].includes(status)) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid transcode callback' });
  }
  const job = await d1First<{ media_asset_id: string }>(event,
    'SELECT media_asset_id FROM transcode_jobs WHERE id = ?', [jobId]);
  if (!job || job.media_asset_id !== assetId) throw createError({ statusCode: 404, statusMessage: 'Transcode job not found' });

  const now = new Date().toISOString();
  if (status === 'processing') {
    await d1Batch(event, [
      { sql: `UPDATE transcode_jobs SET status = 'processing', progress = MAX(progress, ?),
          started_at = COALESCE(started_at, ?), error_message = NULL, updated_at = ? WHERE id = ? AND media_asset_id = ?`,
        params: [progress, now, now, jobId, assetId] },
      { sql: `UPDATE media_assets SET status = 'processing', updated_at = ?
          WHERE id = ? AND deleted_at IS NULL AND status <> 'superseded'`, params: [now, assetId] },
      { sql: `UPDATE episodes SET video_status = 'processing', updated_at = ?
          WHERE active_media_asset_id = ? AND deleted_at IS NULL`, params: [now, assetId] },
    ]);
    return { ok: true, jobId, status, progress };
  }

  if (status === 'failed') {
    const message = String(body.errorMessage || 'FFmpeg transcode failed').slice(0, 1000);
    await d1Batch(event, [
      { sql: `UPDATE transcode_jobs SET status = 'failed', progress = 0, error_message = ?,
          completed_at = ?, updated_at = ? WHERE id = ? AND media_asset_id = ?`, params: [message, now, now, jobId, assetId] },
      { sql: `UPDATE media_assets SET status = 'failed', validation_status = 'invalid', validation_error = ?, updated_at = ?
          WHERE id = ? AND deleted_at IS NULL AND status <> 'superseded'`, params: [message, now, assetId] },
      { sql: `UPDATE episodes SET video_status = 'failed', updated_at = ?
          WHERE active_media_asset_id = ? AND deleted_at IS NULL`, params: [now, assetId] },
      { sql: `UPDATE series SET status = 'draft', updated_at = ? WHERE status = 'processing'
          AND id = (SELECT series_id FROM episodes WHERE active_media_asset_id = ?)
          AND NOT EXISTS (SELECT 1 FROM episodes e WHERE e.series_id = series.id AND e.deleted_at IS NULL
            AND e.video_status IN ('uploading', 'validating', 'processing'))`, params: [now, assetId] },
    ]);
    return { ok: true, jobId, status, errorMessage: message };
  }

  const sourceEtag = String(body.sourceEtag || '');
  const hlsPrefix = String(body.hlsPrefix || '');
  const width = Number(body.media?.width), height = Number(body.media?.height);
  const durationSeconds = Number(body.media?.durationSeconds);
  if (!/^[a-zA-Z0-9_-]{8,160}$/.test(sourceEtag)
    || !hlsPrefix.startsWith(`hls/${assetId}/${encodeURIComponent(sourceEtag)}/`)
    || !hlsPrefix.endsWith('/') || !Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0
    || !Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 21_600
    || body.media?.hasVideo !== true || body.media?.hasAudio !== true
    || !Array.isArray(body.renditions) || !body.renditions.length) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid completed transcode metadata' });
  }
  await d1Batch(event, [
    { sql: `UPDATE transcode_jobs SET status = 'ready', progress = 100, error_code = NULL, error_message = NULL,
        completed_at = ?, updated_at = ? WHERE id = ? AND media_asset_id = ?`, params: [now, now, jobId, assetId] },
    { sql: `UPDATE media_assets SET source_etag = ?, hls_url = ?, width = ?, height = ?, duration_seconds = ?,
        has_video = 1, has_audio = 1, status = 'ready', validation_status = 'valid', validation_error = NULL, updated_at = ?
        WHERE id = ? AND deleted_at IS NULL AND status <> 'superseded'`,
      params: [sourceEtag, hlsPrefix, width, height, durationSeconds, now, assetId] },
    { sql: `UPDATE episodes SET video_status = 'ready', duration_seconds = ?, updated_at = ?
        WHERE active_media_asset_id = ? AND deleted_at IS NULL
        AND EXISTS (SELECT 1 FROM media_assets WHERE id = ? AND deleted_at IS NULL AND status <> 'superseded')`,
      params: [Math.round(durationSeconds), now, assetId, assetId] },
    { sql: `UPDATE series SET status = 'draft', updated_at = ? WHERE status = 'processing'
        AND id = (SELECT series_id FROM episodes WHERE active_media_asset_id = ?)
        AND NOT EXISTS (SELECT 1 FROM episodes e WHERE e.series_id = series.id AND e.deleted_at IS NULL
          AND e.video_status IN ('uploading', 'validating', 'processing'))`, params: [now, assetId] },
  ]);
  return { ok: true, jobId, status: 'ready', progress: 100 };
});
