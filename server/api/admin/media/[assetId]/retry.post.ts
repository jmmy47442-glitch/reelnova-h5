import { ok } from '~/server/utils/response';
import { d1First, d1Run } from '~/server/utils/cloudflare-d1';
import { mediaWorkerRequest } from '~/server/utils/media-pipeline';
import { applyDirectMediaValidation, queueMediaTranscode, type WorkerCompletion } from '~/server/utils/media-upload-state';
import { recordAdminAudit } from '~/server/utils/admin-audit';

export default defineEventHandler(async (event) => {
  const assetId = getRouterParam(event, 'assetId') || '';
  const asset = await d1First<{ source_object_key: string; episode_id: string }>(event,
    `SELECT a.source_object_key, a.episode_id FROM media_assets a JOIN episodes e ON e.active_media_asset_id = a.id
      WHERE a.id = ? AND a.deleted_at IS NULL AND e.deleted_at IS NULL AND a.status IN ('failed', 'uploaded', 'processing', 'ready')`, [assetId]);
  if (!asset?.source_object_key) throw createError({ statusCode: 409, statusMessage: 'Upload a complete video before retrying validation or transcoding' });
  const result = await mediaWorkerRequest<WorkerCompletion>(event, '/videos/verify', { objectKey: asset.source_object_key, assetId });
  if (result.transcodeRequired) {
    await queueMediaTranscode(event, { media_asset_id: assetId, object_key: asset.source_object_key, episode_id: asset.episode_id }, result, true);
  } else {
    await applyDirectMediaValidation(event, assetId, result);
  }
  if (result.valid || result.transcodeRequired) await d1Run(event, `UPDATE media_upload_sessions SET status = 'completed', last_error = NULL,
    completed_at = COALESCE(completed_at, ?), updated_at = ? WHERE media_asset_id = ? AND r2_completed_at IS NOT NULL
    AND status IN ('failed', 'completing')`, [new Date().toISOString(), new Date().toISOString(), assetId]);
  const status = result.transcodeRequired ? 'processing' as const : result.valid ? 'ready' as const : 'failed' as const;
  await recordAdminAudit(event, { module: '短剧管理', action: '重新校验视频', target: assetId,
    detail: status === 'processing' ? '已重新提交 Container 转码' : result.valid ? '校验通过' : result.errorMessage || '校验失败' });
  return ok({ assetId, status, errorMessage: result.errorMessage });
});
