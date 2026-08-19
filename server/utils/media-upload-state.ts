import type { H3Event } from 'h3';
import type { MediaUploadPart } from '~/types/admin';
import { recordAdminAudit } from './admin-audit';
import { d1First, d1Run } from './cloudflare-d1';
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
  r2_completion_key: string;
  stream_idempotency_key: string;
  episode_id: string;
  episode_no: number;
  series_id: string;
  series_title: string;
}

export interface UploadCompletionResult {
  uploadId: string;
  mediaAssetId: string;
  streamUid: string | null;
  status: 'processing' | 'completing';
  errorMessage?: string;
}

interface WorkerCompletion {
  etag: string;
  streamUid: string | null;
  streamError?: string;
}

export const getMediaUploadState = (event: H3Event, uploadId: string) => d1First<MediaUploadStateRow>(event, `SELECT
    u.*, a.episode_id, e.episode_no, e.series_id, s.title AS series_title
  FROM media_upload_sessions u
  JOIN media_assets a ON a.id = u.media_asset_id
  JOIN episodes e ON e.id = a.episode_id
  JOIN series s ON s.id = e.series_id
  WHERE u.id = ?`, [uploadId]);

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
  if (initial.status === 'completed') {
    return { uploadId: initial.id, mediaAssetId: initial.media_asset_id, streamUid: initial.stream_uid, status: 'processing' };
  }
  if (!['created', 'uploading', 'completing', 'failed'].includes(initial.status)) {
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
    let result: WorkerCompletion;
    if (upload.source_etag && upload.stream_uid) {
      result = { etag: upload.source_etag, streamUid: upload.stream_uid };
    } else {
      result = await mediaWorkerRequest<WorkerCompletion>(event,
        `/uploads/${encodeURIComponent(upload.provider_upload_id)}/complete`, {
          uploadId: upload.provider_upload_id,
          sessionId: upload.id,
          completionKey: upload.r2_completion_key,
          streamIdempotencyKey: upload.stream_idempotency_key,
          objectKey: upload.object_key,
          parts,
          metadata: { assetId: upload.media_asset_id, episodeId: upload.episode_id, seriesId: upload.series_id },
        });
    }

    const externalSavedAt = new Date().toISOString();
    await d1Run(event, `UPDATE media_upload_sessions SET source_etag = ?, r2_completed_at = COALESCE(r2_completed_at, ?),
      stream_uid = COALESCE(?, stream_uid), stream_created_at = CASE WHEN ? IS NULL THEN stream_created_at ELSE COALESCE(stream_created_at, ?) END,
      last_error = ?, reconciled_at = ?, updated_at = ? WHERE id = ?`,
    [result.etag, externalSavedAt, result.streamUid, result.streamUid, externalSavedAt,
      result.streamUid ? null : (result.streamError || 'Cloudflare Stream copy is pending recovery'), externalSavedAt, externalSavedAt, upload.id]);

    const saved = await getMediaUploadState(event, upload.id);
    if (saved?.status === 'completed') {
      return { uploadId: saved.id, mediaAssetId: saved.media_asset_id, streamUid: saved.stream_uid, status: 'processing' };
    }
    if (!result.streamUid && saved?.stream_uid) result = { etag: saved.source_etag || result.etag, streamUid: saved.stream_uid };

    if (!result.streamUid) {
      const message = result.streamError || 'R2 upload completed, but Stream copy is pending recovery';
      await d1Run(event, `UPDATE media_assets SET source_etag = ?, status = 'uploaded', validation_status = 'pending',
        validation_error = ?, updated_at = ? WHERE id = ?`, [result.etag, message, externalSavedAt, upload.media_asset_id]);
      await d1Run(event, `UPDATE episodes SET video_status = 'validating', updated_at = ? WHERE id = ?`, [externalSavedAt, upload.episode_id]);
      return { uploadId: upload.id, mediaAssetId: upload.media_asset_id, streamUid: null, status: 'completing', errorMessage: message };
    }

    // External resource identifiers are durable before the session reaches its terminal state.
    await d1Run(event, `UPDATE media_assets SET source_etag = ?, stream_uid = ?, status = 'processing',
      validation_status = 'pending', validation_error = NULL, updated_at = ? WHERE id = ?`,
    [result.etag, result.streamUid, externalSavedAt, upload.media_asset_id]);
    const jobId = `job_${upload.id}`;
    await d1Run(event, `INSERT OR IGNORE INTO transcode_jobs
      (id, media_asset_id, provider_job_id, attempt, status, progress, started_at, created_at, updated_at)
      VALUES (?, ?, ?, 1, 'processing', 0, ?, ?, ?)`,
    [jobId, upload.media_asset_id, result.streamUid, externalSavedAt, externalSavedAt, externalSavedAt]);
    await d1Run(event, `UPDATE transcode_jobs SET provider_job_id = ?, status = 'processing', error_code = NULL,
      error_message = NULL, started_at = COALESCE(started_at, ?), updated_at = ?
      WHERE media_asset_id = ? AND (id = ? OR provider_job_id = ?)`,
    [result.streamUid, externalSavedAt, externalSavedAt, upload.media_asset_id, jobId, result.streamUid]);
    await d1Run(event, `UPDATE episodes SET active_media_asset_id = ?, video_status = 'processing', updated_at = ? WHERE id = ?`,
      [upload.media_asset_id, externalSavedAt, upload.episode_id]);
    await d1Run(event, `UPDATE media_upload_sessions SET uploaded_bytes = file_size_bytes, status = 'completed',
      completed_at = COALESCE(completed_at, ?), last_error = NULL, reconciled_at = ?, updated_at = ? WHERE id = ?`,
    [externalSavedAt, externalSavedAt, externalSavedAt, upload.id]);

    if (audit) {
      await recordAdminAudit(event, {
        module: '短剧管理', action: '提交视频转码', target: `${upload.series_title} · Episode ${upload.episode_no}`,
        detail: `Stream ${result.streamUid}`,
      }).catch(() => undefined);
    }
    return { uploadId: upload.id, mediaAssetId: upload.media_asset_id, streamUid: result.streamUid, status: 'processing' };
  } catch (error) {
    const now = new Date().toISOString();
    await d1Run(event, `UPDATE media_upload_sessions SET status = 'completing', last_error = ?, updated_at = ?
      WHERE id = ? AND status <> 'completed'`,
      [errorMessage(error), now, initial.id]).catch(() => undefined);
    throw error;
  }
};
