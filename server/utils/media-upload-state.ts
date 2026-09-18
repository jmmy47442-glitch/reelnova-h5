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
  status: 'ready' | 'failed';
  errorMessage?: string;
}

export interface WorkerCompletion {
  etag: string;
  valid: boolean;
  errorMessage?: string;
  media?: { width: number; height: number; durationSeconds: number };
}

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
  if (initial.status === 'completed' && ['ready', 'failed'].includes(initial.asset_status)) {
    return { uploadId: initial.id, mediaAssetId: initial.media_asset_id, streamUid: null,
      status: initial.asset_status === 'ready' ? 'ready' : 'failed', errorMessage: initial.asset_error || undefined };
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
    await applyDirectMediaValidation(event, upload.media_asset_id, result);
    await d1Run(event, `UPDATE media_upload_sessions SET uploaded_bytes = file_size_bytes, source_etag = ?,
      r2_completed_at = COALESCE(r2_completed_at, ?), status = ?, completed_at = COALESCE(completed_at, ?),
      last_error = ?, reconciled_at = ?, updated_at = ? WHERE id = ?`,
    [result.etag, now, result.valid ? 'completed' : 'failed', now, result.errorMessage || null, now, now, upload.id]);
    if (audit) {
      await recordAdminAudit(event, {
        module: '短剧管理', action: result.valid ? '视频上传完成' : '视频校验失败',
        target: `${upload.series_title} · Episode ${upload.episode_no}`,
        detail: result.valid ? 'R2 MP4 签名直播放' : result.errorMessage || 'Invalid MP4',
      }).catch(() => undefined);
    }
    return { uploadId: upload.id, mediaAssetId: upload.media_asset_id, streamUid: null,
      status: result.valid ? 'ready' : 'failed', errorMessage: result.errorMessage };
  } catch (error) {
    const now = new Date().toISOString();
    await d1Run(event, `UPDATE media_upload_sessions SET status = 'completing', last_error = ?, updated_at = ?
      WHERE id = ? AND status <> 'completed'`,
      [errorMessage(error), now, initial.id]).catch(() => undefined);
    throw error;
  }
};
