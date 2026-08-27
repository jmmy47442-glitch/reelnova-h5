import { ok } from '~/server/utils/response';
import { recordAdminAudit } from '~/server/utils/admin-audit';
import { d1First, d1Run } from '~/server/utils/cloudflare-d1';
import { getMediaUploadState } from '~/server/utils/media-upload-state';
import { mediaWorkerRequest } from '~/server/utils/media-pipeline';

export default defineEventHandler(async (event) => {
  const uploadId = getRouterParam(event, 'uploadId') || '';
  const upload = await getMediaUploadState(event, uploadId);
  if (!upload) throw createError({ statusCode: 404, statusMessage: 'Upload session not found' });
  if (upload.status === 'aborted') {
    return ok({ uploadId, mediaAssetId: upload.media_asset_id, episodeId: upload.episode_id, status: 'aborted' as const, cleanupPending: false });
  }
  if (!['created', 'uploading'].includes(upload.status) || upload.r2_completed_at) {
    throw createError({ statusCode: 409, statusMessage: 'Upload can no longer be cancelled' });
  }

  const now = new Date().toISOString();
  const previousAsset = await d1First<{ id: string }>(event, `SELECT id FROM media_assets
    WHERE episode_id = ? AND id <> ? AND stream_uid IS NOT NULL AND validation_status = 'valid'
    ORDER BY created_at DESC LIMIT 1`, [upload.episode_id, upload.media_asset_id]);
  await d1Run(event, `UPDATE media_upload_sessions SET status = 'aborted', last_error = 'Upload cancelled by administrator',
    reconciled_at = ?, updated_at = ? WHERE id = ? AND status IN ('created', 'uploading')`, [now, now, upload.id]);
  await d1Run(event, `UPDATE media_assets SET status = 'superseded', validation_error = 'Upload cancelled',
    deleted_at = COALESCE(deleted_at, ?), updated_at = ? WHERE id = ? AND status = 'uploading'`,
  [now, now, upload.media_asset_id]);
  if (previousAsset) {
    await d1Run(event, `UPDATE media_assets SET status = 'ready', deleted_at = NULL, updated_at = ? WHERE id = ?`, [now, previousAsset.id]);
    await d1Run(event, `UPDATE episodes SET active_media_asset_id = ?, video_status = 'ready', updated_at = ?
      WHERE id = ? AND active_media_asset_id = ? AND video_status = 'uploading'`,
    [previousAsset.id, now, upload.episode_id, upload.media_asset_id]);
  } else {
    await d1Run(event, `UPDATE episodes SET active_media_asset_id = NULL, video_status = 'waiting_upload', updated_at = ?
      WHERE id = ? AND active_media_asset_id = ? AND video_status = 'uploading'`, [now, upload.episode_id, upload.media_asset_id]);
  }
  await d1Run(event, `UPDATE series SET status = 'draft', updated_at = ? WHERE id = ? AND status = 'processing'
    AND NOT EXISTS (SELECT 1 FROM episodes WHERE series_id = ? AND deleted_at IS NULL
      AND video_status IN ('uploading', 'validating', 'processing'))`, [now, upload.series_id, upload.series_id]);

  let cleanupPending = false;
  try {
    await mediaWorkerRequest(event, `/uploads/${encodeURIComponent(upload.provider_upload_id)}`, {
      uploadId: upload.provider_upload_id,
      sessionId: upload.id,
      objectKey: upload.object_key,
      idempotencyKey: upload.idempotency_key,
    }, 'DELETE');
  } catch {
    cleanupPending = true;
    await d1Run(event, `UPDATE media_upload_sessions SET last_error = 'Upload cancelled; multipart cleanup pending',
      reconciled_at = NULL, updated_at = ? WHERE id = ?`, [new Date().toISOString(), upload.id]).catch(() => undefined);
  }

  await recordAdminAudit(event, {
    module: '短剧管理', action: '取消视频上传', target: `${upload.series_title} · Episode ${upload.episode_no}`,
    detail: cleanupPending ? '上传已停止；R2 分片等待后台清理' : '上传已停止；R2 分片已清理',
  }).catch(() => undefined);
  return ok({ uploadId, mediaAssetId: upload.media_asset_id, episodeId: upload.episode_id, status: 'aborted' as const, cleanupPending });
});
