import type { MediaUploadPart } from '~/types/admin';
import { ok } from '~/server/utils/response';
import { recordAdminAudit } from '~/server/utils/admin-audit';
import { d1First, d1Run } from '~/server/utils/cloudflare-d1';
import { mediaWorkerRequest } from '~/server/utils/media-pipeline';

interface UploadRow {
  id: string;
  media_asset_id: string;
  provider_upload_id: string;
  object_key: string;
  part_size_bytes: number;
  file_size_bytes: number;
  status: string;
  episode_id: string;
  episode_no: number;
  series_id: string;
  series_title: string;
}

export default defineEventHandler(async (event) => {
  const uploadId = getRouterParam(event, 'uploadId') || '';
  const body = await readBody<{ parts?: MediaUploadPart[] }>(event);
  const upload = await d1First<UploadRow>(event, `SELECT u.*, a.episode_id, e.episode_no, e.series_id, s.title AS series_title
    FROM media_upload_sessions u JOIN media_assets a ON a.id = u.media_asset_id
    JOIN episodes e ON e.id = a.episode_id JOIN series s ON s.id = e.series_id WHERE u.id = ?`, [uploadId]);
  if (!upload) throw createError({ statusCode: 404, statusMessage: 'Upload session not found' });
  if (!['created', 'uploading', 'failed'].includes(upload.status)) throw createError({ statusCode: 409, statusMessage: 'Upload cannot be completed in its current state' });
  const parts = Array.isArray(body?.parts) ? [...body.parts].sort((left, right) => left.partNumber - right.partNumber) : [];
  const expectedCount = Math.ceil(upload.file_size_bytes / upload.part_size_bytes);
  if (parts.length !== expectedCount || parts.some((part, index) => part.partNumber !== index + 1 || !part.etag || part.etag.length > 200)) {
    throw createError({ statusCode: 400, statusMessage: 'Uploaded part list is incomplete' });
  }
  const now = new Date().toISOString();
  await d1Run(event, `UPDATE media_upload_sessions SET status = 'completing', updated_at = ? WHERE id = ?`, [now, uploadId]);
  try {
    const result = await mediaWorkerRequest<{ etag: string; streamUid: string | null; streamError?: string }>(event,
      `/uploads/${encodeURIComponent(upload.provider_upload_id)}/complete`, {
        uploadId: upload.provider_upload_id, objectKey: upload.object_key, parts,
        metadata: { assetId: upload.media_asset_id, episodeId: upload.episode_id, seriesId: upload.series_id },
      });
    const completedAt = new Date().toISOString();
    await d1Run(event, `UPDATE media_upload_sessions SET uploaded_bytes = file_size_bytes, status = 'completed', completed_at = ?, updated_at = ? WHERE id = ?`, [completedAt, completedAt, uploadId]);
    if (result.streamUid) {
      await d1Run(event, `UPDATE media_assets SET source_etag = ?, stream_uid = ?, status = 'processing', validation_status = 'pending', updated_at = ? WHERE id = ?`, [result.etag, result.streamUid, completedAt, upload.media_asset_id]);
      await d1Run(event, `INSERT INTO transcode_jobs
        (id, media_asset_id, provider_job_id, attempt, status, progress, started_at, created_at, updated_at)
        VALUES (?, ?, ?, 1, 'processing', 0, ?, ?, ?)`, [`job_${crypto.randomUUID()}`, upload.media_asset_id, result.streamUid, completedAt, completedAt, completedAt]);
      await d1Run(event, `UPDATE episodes SET video_status = 'processing', updated_at = ? WHERE id = ?`, [completedAt, upload.episode_id]);
      await recordAdminAudit(event, { module: '短剧管理', action: '提交视频转码', target: `${upload.series_title} · Episode ${upload.episode_no}`, detail: `Stream ${result.streamUid}` });
      return ok({ uploadId, mediaAssetId: upload.media_asset_id, streamUid: result.streamUid, status: 'processing' as const });
    }
    const message = result.streamError || 'R2 upload completed, but Stream copy failed';
    await d1Run(event, `UPDATE media_assets SET source_etag = ?, status = 'failed', validation_error = ?, updated_at = ? WHERE id = ?`, [result.etag, message, completedAt, upload.media_asset_id]);
    await d1Run(event, `INSERT INTO transcode_jobs
      (id, media_asset_id, attempt, status, progress, error_code, error_message, completed_at, created_at, updated_at)
      VALUES (?, ?, 1, 'failed', 0, 'STREAM_COPY_FAILED', ?, ?, ?, ?)`, [`job_${crypto.randomUUID()}`, upload.media_asset_id, message, completedAt, completedAt, completedAt]);
    await d1Run(event, `UPDATE episodes SET video_status = 'failed', updated_at = ? WHERE id = ?`, [completedAt, upload.episode_id]);
    return ok({ uploadId, mediaAssetId: upload.media_asset_id, streamUid: null, status: 'failed' as const, errorMessage: message });
  } catch (error) {
    await d1Run(event, `UPDATE media_upload_sessions SET status = 'failed', updated_at = ? WHERE id = ?`, [new Date().toISOString(), uploadId]);
    throw error;
  }
});
