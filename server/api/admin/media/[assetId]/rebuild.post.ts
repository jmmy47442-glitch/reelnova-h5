import { ok } from '~/server/utils/response';
import { recordAdminAudit } from '~/server/utils/admin-audit';
import { d1Batch, d1First } from '~/server/utils/cloudflare-d1';
import { mediaWorkerRequest } from '~/server/utils/media-pipeline';

/** Rebuild a ready Stream rendition from the asset's existing private R2 source. */
export default defineEventHandler(async (event) => {
  const assetId = getRouterParam(event, 'assetId') || '';
  const asset = await d1First<{
    id: string; episode_id: string; source_object_key: string | null; status: string;
    episode_no: number; series_id: string; series_title: string;
  }>(event,
    `SELECT a.id, a.episode_id, a.source_object_key, a.status, e.episode_no, e.series_id, s.title AS series_title
     FROM media_assets a JOIN episodes e ON e.id = a.episode_id JOIN series s ON s.id = e.series_id
     WHERE a.id = ? AND a.deleted_at IS NULL AND e.active_media_asset_id = a.id`, [assetId]);
  if (!asset) throw createError({ statusCode: 404, statusMessage: 'Active media asset not found' });
  if (asset.status !== 'ready' || !asset.source_object_key) {
    throw createError({ statusCode: 409, statusMessage: 'Only ready assets with an existing R2 source can be rebuilt' });
  }

  const latest = await d1First<{ attempt: number; processing: number }>(event,
    'SELECT MAX(attempt) AS attempt, MAX(CASE WHEN status = \'processing\' THEN 1 ELSE 0 END) AS processing FROM transcode_jobs WHERE media_asset_id = ?', [assetId]);
  if (Number(latest?.processing || 0)) throw createError({ statusCode: 409, statusMessage: 'A transcode job is already processing' });
  const attempt = Number(latest?.attempt || 0) + 1;
  const streamIdempotencyKey = `reelnova:rebuild:${assetId}:${attempt}`;
  // The Worker verifies that the object still exists before requesting a
  // Stream copy. D1 is changed only after Stream accepts that copy.
  const result = await mediaWorkerRequest<{ streamUid: string }>(event, '/transcodes', {
    objectKey: asset.source_object_key,
    streamIdempotencyKey,
    metadata: { assetId, episodeId: asset.episode_id, seriesId: asset.series_id, attempt: String(attempt), rebuild: 'true' },
  });
  if (!result.streamUid) throw createError({ statusCode: 502, statusMessage: 'Cloudflare Stream did not return a video ID' });

  const now = new Date().toISOString();
  await d1Batch(event, [
    { sql: `UPDATE media_assets SET stream_uid = ?, status = 'processing', validation_status = 'pending', validation_error = NULL, updated_at = ? WHERE id = ? AND status = 'ready'`, params: [result.streamUid, now, assetId] },
    { sql: `INSERT INTO transcode_jobs
      (id, media_asset_id, provider_job_id, attempt, status, progress, started_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'processing', 0, ?, ?, ?)
      ON CONFLICT(provider_job_id) DO NOTHING`, params: [`job_${crypto.randomUUID()}`, assetId, result.streamUid, attempt, now, now, now] },
    { sql: `UPDATE episodes SET video_status = 'processing', updated_at = ? WHERE id = ? AND active_media_asset_id = ?`, params: [now, asset.episode_id, assetId] },
  ]);
  await recordAdminAudit(event, {
    module: '短剧管理', action: '从 R2 原片重建 Stream',
    target: `${asset.series_title} · Episode ${asset.episode_no}`,
    detail: `第 ${attempt} 次转码；复用现有 R2 原片`,
  });
  return ok({ assetId, streamUid: result.streamUid, attempt, status: 'processing' as const });
});
