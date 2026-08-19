import { ok } from '~/server/utils/response';
import { recordAdminAudit } from '~/server/utils/admin-audit';
import { d1First, d1Run } from '~/server/utils/cloudflare-d1';
import { mediaWorkerRequest } from '~/server/utils/media-pipeline';

export default defineEventHandler(async (event) => {
  const assetId = getRouterParam(event, 'assetId') || '';
  const asset = await d1First<{ id: string; episode_id: string; source_object_key: string; status: string; episode_no: number; series_id: string; series_title: string }>(event,
    `SELECT a.id, a.episode_id, a.source_object_key, a.status, e.episode_no, e.series_id, s.title AS series_title
     FROM media_assets a JOIN episodes e ON e.id = a.episode_id JOIN series s ON s.id = e.series_id WHERE a.id = ? AND a.deleted_at IS NULL`, [assetId]);
  if (!asset) throw createError({ statusCode: 404, statusMessage: 'Media asset not found' });
  if (asset.status !== 'failed' || !asset.source_object_key) throw createError({ statusCode: 409, statusMessage: 'Only failed transcoding jobs can be retried' });
  const previous = await d1First<{ attempt: number }>(event, 'SELECT MAX(attempt) AS attempt FROM transcode_jobs WHERE media_asset_id = ?', [assetId]);
  const attempt = Number(previous?.attempt || 0) + 1;
  if (attempt > 5) throw createError({ statusCode: 409, statusMessage: 'Maximum retry attempts reached' });
  const streamIdempotencyKey = `reelnova:retry:${assetId}:${attempt}`;
  const result = await mediaWorkerRequest<{ streamUid: string }>(event, '/transcodes', {
    objectKey: asset.source_object_key, streamIdempotencyKey,
    metadata: { assetId, episodeId: asset.episode_id, seriesId: asset.series_id, attempt: String(attempt) },
  });
  const now = new Date().toISOString();
  await d1Run(event, `UPDATE media_assets SET stream_uid = ?, status = 'processing', validation_status = 'pending', validation_error = NULL, updated_at = ? WHERE id = ?`, [result.streamUid, now, assetId]);
  await d1Run(event, `INSERT INTO transcode_jobs
    (id, media_asset_id, provider_job_id, attempt, status, progress, started_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'processing', 0, ?, ?, ?)`, [`job_${crypto.randomUUID()}`, assetId, result.streamUid, attempt, now, now, now]);
  await d1Run(event, `UPDATE episodes SET video_status = 'processing', updated_at = ? WHERE id = ?`, [now, asset.episode_id]);
  await recordAdminAudit(event, { module: '短剧管理', action: '重试视频转码', target: `${asset.series_title} · Episode ${asset.episode_no}`, detail: `第 ${attempt} 次尝试` });
  return ok({ assetId, streamUid: result.streamUid, attempt, status: 'processing' as const });
});
