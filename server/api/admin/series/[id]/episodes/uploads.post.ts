import { ok } from '~/server/utils/response';
import { recordAdminAudit } from '~/server/utils/admin-audit';
import { d1First, d1Run } from '~/server/utils/cloudflare-d1';
import { mediaWorkerRequest, requireMediaPipeline } from '~/server/utils/media-pipeline';

const allowedTypes = new Set(['video/mp4', 'video/quicktime']);
const allowedExtensions = new Set(['mp4', 'mov']);

interface WorkerUpload {
  uploadId: string;
  objectKey: string;
  uploadUrl: string;
  uploadToken: string;
  partSizeBytes: number;
  expiresAt: string;
}

interface ExistingUpload extends WorkerUpload {
  id: string;
  episode_id: string;
  media_asset_id: string;
  source_file_name: string;
  source_size_bytes: number;
  status: string;
}

export default defineEventHandler(async (event) => {
  requireMediaPipeline(event);
  const seriesId = getRouterParam(event, 'id') || '';
  const series = await d1First<{ id: string; title: string; free_episode_count: number }>(event,
    'SELECT id, title, free_episode_count FROM series WHERE id = ? AND deleted_at IS NULL', [seriesId]);
  if (!series) throw createError({ statusCode: 404, statusMessage: 'Series not found' });

  const body = await readBody<{ idempotencyKey?: unknown; episodeNo?: unknown; title?: unknown; fileName?: unknown; contentType?: unknown; fileSizeBytes?: unknown; durationSeconds?: unknown; width?: unknown; height?: unknown; hasVideo?: unknown; hasAudio?: unknown }>(event);
  const idempotencyKey = String(body?.idempotencyKey || '').trim();
  const episodeNo = Number(body?.episodeNo);
  const fileName = String(body?.fileName || '').trim();
  const contentType = String(body?.contentType || '').toLowerCase();
  const fileSizeBytes = Number(body?.fileSizeBytes);
  const extension = fileName.split('.').pop()?.toLowerCase() || '';
  const title = String(body?.title || `Episode ${episodeNo}`).trim();
  const durationSeconds = Number(body?.durationSeconds);
  const width = Number(body?.width);
  const height = Number(body?.height);
  if (!/^upload:[0-9a-f-]{36}$/i.test(idempotencyKey)
    || !Number.isInteger(episodeNo) || episodeNo < 1 || episodeNo > 10_000 || !title || title.length > 120
    || !fileName || fileName.length > 240 || !allowedTypes.has(contentType) || !allowedExtensions.has(extension)
    || !Number.isSafeInteger(fileSizeBytes) || fileSizeBytes < 1024 || fileSizeBytes > 20 * 1024 * 1024 * 1024
    || !Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 6 * 60 * 60
    || !Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0 || body?.hasVideo !== true || body?.hasAudio !== true) {
    throw createError({ statusCode: 400, statusMessage: 'Only MP4/MOV videos up to 20 GB are accepted' });
  }

  const previous = await d1First<ExistingUpload>(event, `SELECT u.id, u.provider_upload_id AS uploadId, u.object_key AS objectKey,
      u.part_size_bytes AS partSizeBytes, u.expires_at AS expiresAt, u.status, u.media_asset_id, a.episode_id,
      a.source_file_name, a.source_size_bytes
    FROM media_upload_sessions u JOIN media_assets a ON a.id = u.media_asset_id WHERE u.idempotency_key = ?`, [idempotencyKey]);
  if (previous) {
    if (previous.source_file_name !== fileName || Number(previous.source_size_bytes) !== fileSizeBytes) {
      throw createError({ statusCode: 409, statusMessage: 'Idempotency key is already assigned to another upload' });
    }
    if (['completed', 'aborted', 'expired'].includes(previous.status)) {
      throw createError({ statusCode: 409, statusMessage: 'Upload session is no longer active' });
    }
    const worker = await mediaWorkerRequest<WorkerUpload>(event, '/uploads', {
      idempotencyKey, sessionId: previous.id, completionKey: `r2:${previous.id}`,
      streamIdempotencyKey: `reelnova:upload:${previous.id}`, objectKey: previous.objectKey, contentType, fileSizeBytes,
      metadata: { assetId: previous.media_asset_id, episodeId: previous.episode_id, seriesId },
    });
    await d1Run(event, `UPDATE media_upload_sessions SET provider_upload_id = ?, part_size_bytes = ?, expires_at = ?,
      last_error = NULL, updated_at = ? WHERE id = ?`, [worker.uploadId, worker.partSizeBytes, worker.expiresAt, new Date().toISOString(), previous.id]);
    return ok({
      id: previous.id, episodeId: previous.episode_id, mediaAssetId: previous.media_asset_id, episodeNo,
      uploadUrl: worker.uploadUrl, uploadToken: worker.uploadToken, partSizeBytes: worker.partSizeBytes, expiresAt: worker.expiresAt,
    });
  }

  const existing = await d1First<{ id: string; video_status: string }>(event,
    'SELECT id, video_status FROM episodes WHERE series_id = ? AND episode_no = ? AND deleted_at IS NULL', [seriesId, episodeNo]);
  if (existing && ['uploading', 'validating', 'processing'].includes(existing.video_status)) {
    throw createError({ statusCode: 409, statusMessage: 'This episode already has an active media job' });
  }

  const episodeId = existing?.id || `ep_${crypto.randomUUID()}`;
  const assetId = `media_${crypto.randomUUID()}`;
  const sessionId = `upload_${crypto.randomUUID()}`;
  const safeName = `${episodeNo}-${crypto.randomUUID().slice(0, 8)}.${extension}`;
  const objectKey = `originals/${seriesId}/${episodeId}/${assetId}/${safeName}`;
  const now = new Date().toISOString();

  if (existing) {
    // Keep replaced media out of the active catalogue and reconciliation set.
    // The new asset becomes active only after its Stream job is submitted.
    await d1Run(event, `UPDATE media_assets SET status = 'superseded', deleted_at = COALESCE(deleted_at, ?), updated_at = ?
      WHERE episode_id = ? AND deleted_at IS NULL AND status <> 'superseded'`, [now, now, episodeId]);
    await d1Run(event, `UPDATE episodes SET title = ?, is_free = ?, video_status = 'uploading', active_media_asset_id = NULL,
      updated_at = ? WHERE id = ?`, [title, episodeNo <= series.free_episode_count ? 1 : 0, now, episodeId]);
  } else {
    await d1Run(event, `INSERT INTO episodes
      (id, series_id, episode_no, title, duration_seconds, is_free, video_status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 0, ?, 'uploading', ?, ?)`, [episodeId, seriesId, episodeNo, title, episodeNo <= series.free_episode_count ? 1 : 0, now, now]);
  }
  await d1Run(event, `INSERT INTO media_assets
    (id, episode_id, kind, storage_provider, source_object_key, source_file_name, source_content_type,
     source_size_bytes, width, height, duration_seconds, has_video, has_audio, validation_status, status, created_at, updated_at)
    VALUES (?, ?, 'video', 'r2', ?, ?, ?, ?, ?, ?, ?, 1, 1, 'pending', 'uploading', ?, ?)`,
  [assetId, episodeId, objectKey, fileName, contentType, fileSizeBytes, width, height, durationSeconds, now, now]);
  await d1Run(event, 'UPDATE episodes SET active_media_asset_id = ? WHERE id = ?', [assetId, episodeId]);
  await d1Run(event, `INSERT INTO media_upload_sessions
    (id, media_asset_id, provider_upload_id, object_key, part_size_bytes, file_size_bytes, status, expires_at,
     idempotency_key, r2_completion_key, stream_idempotency_key, created_at, updated_at)
    VALUES (?, ?, ?, ?, 10485760, ?, 'created', ?, ?, ?, ?, ?, ?)`,
  [sessionId, assetId, `pending:${sessionId}`, objectKey, fileSizeBytes, new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    idempotencyKey, `r2:${sessionId}`, `reelnova:upload:${sessionId}`, now, now]);
  await d1Run(event, `UPDATE series SET status = CASE WHEN status = 'rights_frozen' THEN status ELSE 'processing' END, updated_at = ? WHERE id = ?`, [now, seriesId]);
  let worker: WorkerUpload;
  try {
    worker = await mediaWorkerRequest<WorkerUpload>(event, '/uploads', {
      idempotencyKey, sessionId, completionKey: `r2:${sessionId}`, streamIdempotencyKey: `reelnova:upload:${sessionId}`,
      objectKey, contentType, fileSizeBytes, metadata: { assetId, episodeId, seriesId },
    });
    await d1Run(event, `UPDATE media_upload_sessions SET provider_upload_id = ?, object_key = ?, part_size_bytes = ?, expires_at = ?,
      last_error = NULL, updated_at = ? WHERE id = ?`, [worker.uploadId, worker.objectKey, worker.partSizeBytes, worker.expiresAt, now, sessionId]);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Multipart upload provisioning failed';
    await d1Run(event, 'UPDATE media_upload_sessions SET last_error = ?, updated_at = ? WHERE id = ?', [message, now, sessionId]).catch(() => undefined);
    throw error;
  }
  await recordAdminAudit(event, { module: '短剧管理', action: '创建分集上传', target: `${series.title} · Episode ${episodeNo}`, detail: `${fileName} · ${fileSizeBytes} bytes` });
  return ok({
    id: sessionId, episodeId, mediaAssetId: assetId, episodeNo, uploadUrl: worker.uploadUrl,
    uploadToken: worker.uploadToken, partSizeBytes: worker.partSizeBytes, expiresAt: worker.expiresAt,
  });
});
