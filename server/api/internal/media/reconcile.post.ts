import { d1All, d1Run } from '~/server/utils/cloudflare-d1';
import { completeMediaUpload, getMediaUploadState } from '~/server/utils/media-upload-state';
import { mediaWorkerRequest } from '~/server/utils/media-pipeline';
import { verifyMediaWorkerRequest } from '~/server/utils/internal-worker-auth';

interface ExpiredUpload {
  id: string;
  provider_upload_id: string;
  object_key: string;
  idempotency_key: string;
}

interface CleanupResult {
  abortedSessionIds: string[];
  deletedObjectKeys: string[];
  deletedStreamUids: string[];
  deletedMarkerKeys: string[];
  errors: Array<{ resource: string; message: string }>;
}

export default defineEventHandler(async (event) => {
  const rawBody = await readRawBody(event, 'utf8') || '';
  if (!await verifyMediaWorkerRequest(event, rawBody)) throw createError({ statusCode: 401, statusMessage: 'Invalid media reconciliation signature' });

  const staleBefore = new Date(Date.now() - 2 * 60 * 1000).toISOString();
  const recoverable = await d1All<{ id: string }>(event, `SELECT id FROM media_upload_sessions
    WHERE status = 'completing' AND completion_parts_json IS NOT NULL AND updated_at < ? ORDER BY updated_at ASC LIMIT 20`, [staleBefore]);
  const recovered: string[] = [];
  const recoveryErrors: Array<{ uploadId: string; message: string }> = [];
  for (const item of recoverable) {
    const upload = await getMediaUploadState(event, item.id);
    if (!upload) continue;
    try {
      const completion = await completeMediaUpload(event, upload, [], false);
      if (completion.status === 'processing') recovered.push(item.id);
    } catch (error) {
      recoveryErrors.push({ uploadId: item.id, message: error instanceof Error ? error.message : 'Upload recovery failed' });
    }
  }

  const now = new Date().toISOString();
  const expired = await d1All<ExpiredUpload>(event, `SELECT id, provider_upload_id, object_key, idempotency_key
    FROM media_upload_sessions WHERE status IN ('created', 'uploading') AND expires_at < ? ORDER BY expires_at ASC LIMIT 100`, [now]);
  const keepObjects = await d1All<{ value: string }>(event, `SELECT source_object_key AS value FROM media_assets
    WHERE source_object_key IS NOT NULL AND deleted_at IS NULL AND status <> 'superseded'
      AND NOT EXISTS (SELECT 1 FROM media_upload_sessions u WHERE u.media_asset_id = media_assets.id
        AND (u.status IN ('aborted', 'expired') OR (u.status IN ('created', 'uploading') AND u.expires_at < ?)))
    `, [now]);
  const keepStreams = await d1All<{ value: string }>(event, `SELECT stream_uid AS value FROM media_assets
    WHERE stream_uid IS NOT NULL AND deleted_at IS NULL AND status <> 'superseded'
    UNION SELECT stream_uid AS value FROM media_upload_sessions WHERE stream_uid IS NOT NULL AND status = 'completing'`);
  const keepSessions = await d1All<{ value: string }>(event, `SELECT id AS value FROM media_upload_sessions
    WHERE status IN ('created', 'uploading', 'completing') AND (expires_at >= ? OR status = 'completing')`, [now]);

  const cleanup = await mediaWorkerRequest<CleanupResult>(event, '/reconcile', {
    graceHours: 24,
    abortUploads: expired.map((upload) => ({
      sessionId: upload.id, uploadId: upload.provider_upload_id, objectKey: upload.object_key, idempotencyKey: upload.idempotency_key,
    })),
    keepObjectKeys: keepObjects.map((item) => item.value),
    keepStreamUids: keepStreams.map((item) => item.value),
    keepSessionIds: keepSessions.map((item) => item.value),
  });

  for (const uploadId of cleanup.abortedSessionIds) {
    await d1Run(event, `UPDATE media_upload_sessions SET status = 'expired', last_error = 'Upload expired and multipart was reconciled',
      reconciled_at = ?, updated_at = ? WHERE id = ? AND status IN ('created', 'uploading')`, [now, now, uploadId]);
    await d1Run(event, `UPDATE media_assets SET status = 'failed', validation_error = 'Upload session expired', updated_at = ?
      WHERE id = (SELECT media_asset_id FROM media_upload_sessions WHERE id = ?) AND status = 'uploading'`, [now, uploadId]);
    await d1Run(event, `UPDATE episodes SET video_status = 'failed', updated_at = ? WHERE id = (
      SELECT a.episode_id FROM media_assets a JOIN media_upload_sessions u ON u.media_asset_id = a.id WHERE u.id = ?
    ) AND video_status = 'uploading'`, [now, uploadId]);
  }

  return {
    ok: true,
    recovered,
    recoveryErrors,
    cleanup,
    completedAt: new Date().toISOString(),
  };
});
