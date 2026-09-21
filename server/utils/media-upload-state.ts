import type { H3Event } from 'h3';
import type { MediaUploadPart } from '~/types/admin';
import { recordAdminAudit } from './admin-audit';
import { d1Batch, d1First, d1Run } from './cloudflare-d1';
import { mediaWorkerRequest } from './media-pipeline';

export interface MediaUploadStateRow {
  id: string;
  media_asset_id: string;
  provider_upload_id: string;
  object_key: string;
  part_size_bytes: number;
  file_size_bytes: number;
  uploaded_bytes: number;
  status: string;
  completion_parts_json: string | null;
  source_etag: string | null;
  stream_uid: string | null;
  r2_completed_at: string | null;
  stream_created_at: string | null;
  last_error: string | null;
  reconciled_at: string | null;
  idempotency_key: string;
  r2_completion_key: string;
  stream_idempotency_key: string;
  asset_stream_uid: string | null;
  asset_status: string;
  asset_error: string | null;
  episode_id: string;
  episode_no: number;
  series_id: string;
  series_title: string;
}

export interface UploadCompletionResult {
  uploadId: string;
  mediaAssetId: string;
  streamUid: string | null;
  status: 'ready' | 'processing' | 'failed';
  errorMessage?: string;
}

export interface WorkerCompletion {
  etag: string;
  sourceEtag?: string;
  valid: boolean;
  status?: 'ready' | 'processing';
  transcodeRequired?: boolean;
  directPlayError?: string;
  errorMessage?: string;
  media?: { width: number; height: number; durationSeconds: number };
}

export const queueMediaTranscode = async (
  event: H3Event,
  upload: Pick<MediaUploadStateRow, 'media_asset_id' | 'object_key' | 'episode_id'>,
  result: WorkerCompletion,
  restart = false,
) => {
  const sourceEtag = String(result.sourceEtag || '').replace(/^"|"$/g, '');
  if (!sourceEtag) throw createError({ statusCode: 502, statusMessage: 'R2 source ETag is missing for transcoding' });
  const jobId = `transcode_${upload.media_asset_id}`;
  const buildId = upload.media_asset_id.replace(/^media_/, '');
  const now = new Date().toISOString();
  await d1Batch(event, [
    { sql: `INSERT INTO transcode_jobs
        (id, media_asset_id, provider_job_id, attempt, status, progress, error_message, created_at, updated_at)
        VALUES (?, ?, ?, 1, 'queued', 0, NULL, ?, ?)
        ON CONFLICT(id) DO UPDATE SET attempt = CASE WHEN ? THEN transcode_jobs.attempt + 1 ELSE transcode_jobs.attempt END,
          status = 'queued', progress = 0, error_code = NULL, error_message = NULL, completed_at = NULL, updated_at = excluded.updated_at`,
      params: [jobId, upload.media_asset_id, jobId, now, now, restart ? 1 : 0] },
    { sql: `UPDATE media_assets SET source_etag = ?, status = 'processing', validation_status = 'pending',
        validation_error = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL AND status <> 'superseded'`,
      params: [sourceEtag, result.directPlayError || null, now, upload.media_asset_id] },
    { sql: `UPDATE episodes SET video_status = 'processing', updated_at = ?
        WHERE id = ? AND active_media_asset_id = ? AND deleted_at IS NULL`,
      params: [now, upload.episode_id, upload.media_asset_id] },
  ]);
  try {
    const started = await mediaWorkerRequest<{ workflowId: string }>(event, '/transcodes', {
      jobId, assetId: upload.media_asset_id, sourceObjectKey: upload.object_key, sourceEtag, buildId, restart,
    });
    await d1Run(event, `UPDATE transcode_jobs SET provider_job_id = ?, status = 'processing', progress = MAX(progress, 1),
      started_at = COALESCE(started_at, ?), error_message = NULL, updated_at = ? WHERE id = ?`,
    [started.workflowId || jobId, now, now, jobId]);
    return { jobId, workflowId: started.workflowId || jobId };
  } catch (error) {
    const message = errorMessage(error);
    await d1Run(event, `UPDATE transcode_jobs SET status = 'queued', error_message = ?, updated_at = ? WHERE id = ?`,
      [message, now, jobId]).catch(() => undefined);
    throw error;
  }
};

// Commit validation and episode state together. Stale completion/retry requests
// must never reactivate a replaced or deleted asset.
export const applyDirectMediaValidation = async (event: H3Event, assetId: string, result: WorkerCompletion) => {
  const now = new Date().toISOString();
  const valid = result.valid && Boolean(result.media);
  await d1Batch(event, [
    { sql: `UPDATE media_assets SET source_etag = ?, status = ?, validation_status = ?, validation_error = ?,
        width = COALESCE(?, width), height = COALESCE(?, height), duration_seconds = COALESCE(?, duration_seconds),
        has_video = ?, has_audio = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL AND status <> 'superseded'`,
      params: [result.etag, valid ? 'ready' : 'failed', valid ? 'valid' : 'invalid', valid ? null : result.errorMessage || 'Invalid MP4',
        result.media?.width ?? null, result.media?.height ?? null, result.media?.durationSeconds ?? null, valid ? 1 : 0, valid ? 1 : 0, now, assetId] },
    { sql: `UPDATE episodes SET video_status = ?, duration_seconds = COALESCE(?, duration_seconds), updated_at = ?
        WHERE active_media_asset_id = ? AND deleted_at IS NULL
        AND EXISTS (SELECT 1 FROM media_assets WHERE id = ? AND deleted_at IS NULL AND status <> 'superseded')`,
      params: [valid ? 'ready' : 'failed', valid ? Math.round(result.media!.durationSeconds) : null, now, assetId, assetId] },
    { sql: `UPDATE transcode_jobs SET status = 'cancelled', updated_at = ? WHERE media_asset_id = ? AND status IN ('queued', 'processing', 'failed')`, params: [now, assetId] },
    { sql: `UPDATE series SET status = 'draft', updated_at = ? WHERE status = 'processing'
        AND id = (SELECT series_id FROM episodes WHERE active_media_asset_id = ?)
        AND NOT EXISTS (SELECT 1 FROM episodes e WHERE e.series_id = series.id AND e.deleted_at IS NULL
          AND e.video_status IN ('uploading', 'validating', 'processing'))`, params: [now, assetId] },
  ]);
};

export const getMediaUploadState = (event: H3Event, uploadId: string) => d1First<MediaUploadStateRow>(event, `SELECT
    u.*, a.stream_uid AS asset_stream_uid, a.status AS asset_status, a.validation_error AS asset_error, a.episode_id, e.episode_no, e.series_id, s.title AS series_title
  FROM media_upload_sessions u
  JOIN media_assets a ON a.id = u.media_asset_id
  JOIN episodes e ON e.id = a.episode_id
  JOIN series s ON s.id = e.series_id
  WHERE u.id = ?`, [uploadId]);

// The episode list can briefly render an uploading episode before the upload
// session id has propagated to the client. Resolve the current session by
// episode as a safe fallback for the cancel action.
export const getActiveMediaUploadStateByEpisode = (event: H3Event, episodeId: string) => d1First<MediaUploadStateRow>(event, `SELECT
    u.*, a.stream_uid AS asset_stream_uid, a.status AS asset_status, a.validation_error AS asset_error, a.episode_id, e.episode_no, e.series_id, s.title AS series_title
  FROM media_upload_sessions u
  JOIN media_assets a ON a.id = u.media_asset_id
  JOIN episodes e ON e.id = a.episode_id
  JOIN series s ON s.id = e.series_id
  WHERE e.id = ? AND u.status IN ('created', 'uploading')
  ORDER BY u.created_at DESC LIMIT 1`, [episodeId]);

const normalizeParts = (parts: MediaUploadPart[]) => [...parts].sort((left, right) => left.partNumber - right.partNumber);

const validateParts = (upload: MediaUploadStateRow, parts: MediaUploadPart[]) => {
  const normalized = normalizeParts(parts);
  const expectedCount = Math.ceil(upload.file_size_bytes / upload.part_size_bytes);
  if (normalized.length !== expectedCount
    || normalized.some((part, index) => part.partNumber !== index + 1 || !part.etag || part.etag.length > 200)) {
    throw createError({ statusCode: 400, statusMessage: 'Uploaded part list is incomplete' });
  }
  return normalized;
};

const errorMessage = (error: unknown) => {
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error && 'statusMessage' in error) return String(error.statusMessage || 'Upload completion failed');
  return 'Upload completion failed';
};

export const completeMediaUpload = async (
  event: H3Event,
  initial: MediaUploadStateRow,
  submittedParts: MediaUploadPart[] = [],
  audit = true,
): Promise<UploadCompletionResult> => {
  if (initial.status === 'completed' && ['ready', 'processing', 'failed'].includes(initial.asset_status)) {
    return { uploadId: initial.id, mediaAssetId: initial.media_asset_id, streamUid: null,
      status: initial.asset_status as 'ready' | 'processing' | 'failed', errorMessage: initial.asset_error || undefined };
  }
  if (!['created', 'uploading', 'completing', 'failed', 'completed'].includes(initial.status)) {
    throw createError({ statusCode: 409, statusMessage: 'Upload cannot be completed in its current state' });
  }
  if (initial.provider_upload_id.startsWith('pending:')) {
    throw createError({ statusCode: 409, statusMessage: 'Multipart upload is still being provisioned' });
  }

  let parts: MediaUploadPart[];
  if (initial.completion_parts_json) {
    parts = validateParts(initial, JSON.parse(initial.completion_parts_json) as MediaUploadPart[]);
  } else {
    parts = validateParts(initial, submittedParts);
    const now = new Date().toISOString();
    await d1Run(event, `UPDATE media_upload_sessions SET completion_parts_json = ?, status = 'completing',
      last_error = NULL, updated_at = ? WHERE id = ? AND status IN ('created', 'uploading', 'failed', 'completing')`,
    [JSON.stringify(parts), now, initial.id]);
  }

  const upload = await getMediaUploadState(event, initial.id);
  if (!upload) throw createError({ statusCode: 404, statusMessage: 'Upload session not found' });
  try {
    const result = await mediaWorkerRequest<WorkerCompletion>(event,
      `/uploads/${encodeURIComponent(upload.provider_upload_id)}/complete`, {
        uploadId: upload.provider_upload_id, sessionId: upload.id,
        completionKey: upload.r2_completion_key, objectKey: upload.object_key,
        fileSizeBytes: upload.file_size_bytes, parts,
        metadata: { assetId: upload.media_asset_id, episodeId: upload.episode_id, seriesId: upload.series_id },
      });
    const now = new Date().toISOString();
    if (result.transcodeRequired) await queueMediaTranscode(event, upload, result);
    else await applyDirectMediaValidation(event, upload.media_asset_id, result);
    const status = result.transcodeRequired ? 'processing' : result.valid ? 'ready' : 'failed';
    await d1Run(event, `UPDATE media_upload_sessions SET uploaded_bytes = file_size_bytes, source_etag = ?,
      r2_completed_at = COALESCE(r2_completed_at, ?), status = ?, completed_at = COALESCE(completed_at, ?),
      last_error = ?, reconciled_at = ?, updated_at = ? WHERE id = ?`,
    [result.sourceEtag || result.etag, now, status === 'failed' ? 'failed' : 'completed', now,
      result.errorMessage || null, now, now, upload.id]);
    if (audit) {
      await recordAdminAudit(event, {
        module: '短剧管理', action: status === 'processing' ? '视频转码已排队' : result.valid ? '视频上传完成' : '视频校验失败',
        target: `${upload.series_title} · Episode ${upload.episode_no}`,
        detail: status === 'processing' ? 'Cloudflare Container FFmpeg HLS' : result.valid ? 'R2 兼容 MP4 签名直播放' : result.errorMessage || 'Invalid video',
      }).catch(() => undefined);
    }
    return { uploadId: upload.id, mediaAssetId: upload.media_asset_id, streamUid: null,
      status, errorMessage: result.errorMessage };
  } catch (error) {
    const now = new Date().toISOString();
    await d1Run(event, `UPDATE media_upload_sessions SET status = 'completing', last_error = ?, updated_at = ?
      WHERE id = ? AND status <> 'completed'`,
      [errorMessage(error), now, initial.id]).catch(() => undefined);
    throw error;
  }
};
