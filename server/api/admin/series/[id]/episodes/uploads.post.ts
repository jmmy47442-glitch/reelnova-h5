import { ok } from '~/server/utils/response';
import { recordAdminAudit } from '~/server/utils/admin-audit';
import { d1Batch, d1First, d1Run } from '~/server/utils/cloudflare-d1';
import { mediaWorkerRequest, requireMediaPipeline } from '~/server/utils/media-pipeline';

const allowedInputs = new Map<string, Set<string>>([
  ['mp4', new Set(['video/mp4'])],
  ['m4v', new Set(['video/mp4', 'video/x-m4v'])],
  ['mov', new Set(['video/quicktime'])],
  ['mkv', new Set(['video/x-matroska', 'application/octet-stream'])],
  ['webm', new Set(['video/webm'])],
  ['avi', new Set(['video/x-msvideo', 'video/avi'])],
  ['mpg', new Set(['video/mpeg'])],
  ['mpeg', new Set(['video/mpeg'])],
]);

interface WorkerUpload {
  uploadId: string;
  objectKey: string;
  uploadUrl: string;
  uploadToken: string;
  partSizeBytes: number;
  expiresAt: string;
}

interface ExistingUpload {
  id: string;
  uploadId: string;
  objectKey: string;
  partSizeBytes: number;
  expiresAt: string;
  episode_id: string;
  media_asset_id: string;
  source_file_name: string;
  source_size_bytes: number;
  status: string;
  idempotency_key: string;
  object_key: string;
  expires_at: string;
  r2_completed_at: string | null;
}

interface UploadSetupRow {
  series_id: string;
  series_title: string;
  free_episode_count: number;
  episode_id: string | null;
  video_status: string | null;
  previous_id: string | null;
  previous_upload_id: string | null;
  previous_object_key: string | null;
  previous_part_size_bytes: number | null;
  previous_expires_at: string | null;
  previous_status: string | null;
  previous_media_asset_id: string | null;
  previous_episode_id: string | null;
  previous_file_name: string | null;
  previous_file_size: number | null;
  previous_idempotency_key: string | null;
  previous_r2_completed_at: string | null;
  active_id: string | null;
  active_upload_id: string | null;
  active_object_key: string | null;
  active_part_size_bytes: number | null;
  active_expires_at: string | null;
  active_status: string | null;
  active_media_asset_id: string | null;
  active_episode_id: string | null;
  active_file_name: string | null;
  active_file_size: number | null;
  active_idempotency_key: string | null;
  active_r2_completed_at: string | null;
}

export default defineEventHandler(async (event) => {
  requireMediaPipeline(event);
  const seriesId = getRouterParam(event, 'id') || '';
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
  const probeValid = Number.isFinite(durationSeconds) && durationSeconds > 0 && durationSeconds <= 6 * 60 * 60
    && Number.isInteger(width) && width > 0 && Number.isInteger(height) && height > 0
    && body?.hasVideo === true && body?.hasAudio === true;
  if (!/^upload:[0-9a-f-]{36}$/i.test(idempotencyKey)
    || !Number.isInteger(episodeNo) || episodeNo < 1 || episodeNo > 10_000 || !title || title.length > 120
    || !fileName || fileName.length > 240 || !allowedInputs.get(extension)?.has(contentType)
    || !Number.isSafeInteger(fileSizeBytes) || fileSizeBytes < 1024 || fileSizeBytes > 20 * 1024 * 1024 * 1024) {
    throw createError({ statusCode: 400, statusMessage: 'Supported inputs: MP4, M4V, MOV, MKV, WebM, AVI and MPEG up to 20 GB' });
  }

  // Use one D1 read for the series, idempotency session, target episode, and
  // recoverable session. The REST fallback adds network latency to every D1
  // round trip; serial lookups here could consume the Pages request budget
  // before the Worker has even created the multipart session.
  const setup = await d1First<UploadSetupRow>(event, `SELECT s.id AS series_id, s.title AS series_title, s.free_episode_count,
      e.id AS episode_id, e.video_status,
      pu.id AS previous_id, pu.provider_upload_id AS previous_upload_id, pu.object_key AS previous_object_key,
      pu.part_size_bytes AS previous_part_size_bytes, pu.expires_at AS previous_expires_at, pu.status AS previous_status,
      pu.media_asset_id AS previous_media_asset_id, pa.episode_id AS previous_episode_id,
      pa.source_file_name AS previous_file_name, pa.source_size_bytes AS previous_file_size,
      pu.idempotency_key AS previous_idempotency_key, pu.r2_completed_at AS previous_r2_completed_at,
      au.id AS active_id, au.provider_upload_id AS active_upload_id, au.object_key AS active_object_key,
      au.part_size_bytes AS active_part_size_bytes, au.expires_at AS active_expires_at, au.status AS active_status,
      au.media_asset_id AS active_media_asset_id, aa.episode_id AS active_episode_id,
      aa.source_file_name AS active_file_name, aa.source_size_bytes AS active_file_size,
      au.idempotency_key AS active_idempotency_key, au.r2_completed_at AS active_r2_completed_at
    FROM series s
    LEFT JOIN episodes e ON e.series_id = s.id AND e.episode_no = ? AND e.deleted_at IS NULL
    LEFT JOIN media_upload_sessions pu ON pu.id = (SELECT id FROM media_upload_sessions WHERE idempotency_key = ? LIMIT 1)
    LEFT JOIN media_assets pa ON pa.id = pu.media_asset_id
    LEFT JOIN media_upload_sessions au ON au.id = (
      SELECT u.id FROM media_upload_sessions u JOIN media_assets a ON a.id = u.media_asset_id
      WHERE a.episode_id = e.id AND u.status IN ('created', 'uploading', 'failed')
      ORDER BY u.created_at DESC LIMIT 1)
    LEFT JOIN media_assets aa ON aa.id = au.media_asset_id
    WHERE s.id = ? AND s.deleted_at IS NULL`, [episodeNo, idempotencyKey, seriesId]);
  if (!setup) throw createError({ statusCode: 404, statusMessage: 'Series not found' });

  const series = { id: setup.series_id, title: setup.series_title, free_episode_count: Number(setup.free_episode_count) };
  const previous: ExistingUpload | null = setup.previous_id ? {
    id: setup.previous_id,
    uploadId: setup.previous_upload_id || '',
    objectKey: setup.previous_object_key || '',
    partSizeBytes: Number(setup.previous_part_size_bytes || 0),
    expiresAt: setup.previous_expires_at || '',
    status: setup.previous_status || '',
    media_asset_id: setup.previous_media_asset_id || '',
    episode_id: setup.previous_episode_id || '',
    source_file_name: setup.previous_file_name || '',
    source_size_bytes: Number(setup.previous_file_size || 0),
    idempotency_key: setup.previous_idempotency_key || '',
    object_key: setup.previous_object_key || '',
    expires_at: setup.previous_expires_at || '',
    r2_completed_at: setup.previous_r2_completed_at,
  } : null;
  if (previous) {
    if (previous.source_file_name !== fileName || Number(previous.source_size_bytes) !== fileSizeBytes) {
      throw createError({ statusCode: 409, statusMessage: 'Idempotency key is already assigned to another upload' });
    }
    if (['completed', 'aborted', 'expired'].includes(previous.status)) {
      throw createError({ statusCode: 409, statusMessage: 'Upload session is no longer active' });
    }
    const worker = await mediaWorkerRequest<WorkerUpload>(event, '/uploads', {
      idempotencyKey, sessionId: previous.id, completionKey: `r2:${previous.id}`,
      streamIdempotencyKey: `reelnova:upload:${previous.id}`,
      objectKey: previous.objectKey, contentType, fileSizeBytes,
      metadata: { assetId: previous.media_asset_id, episodeId: previous.episode_id, seriesId },
    // Keep provisioning below the Pages edge request budget. The Worker
    // operation is idempotent; a second bounded attempt is enough to recover
    // a transient 502 without holding the browser request for a minute.
    }, 'POST', { maxAttempts: 2, timeoutMs: 10_000 });
    await d1Run(event, `UPDATE media_upload_sessions SET provider_upload_id = ?, part_size_bytes = ?, expires_at = ?,
      last_error = NULL, updated_at = ? WHERE id = ?`, [worker.uploadId, worker.partSizeBytes, worker.expiresAt, new Date().toISOString(), previous.id]);
    return ok({
      id: previous.id, episodeId: previous.episode_id, mediaAssetId: previous.media_asset_id, episodeNo,
      uploadUrl: worker.uploadUrl, uploadToken: worker.uploadToken, partSizeBytes: worker.partSizeBytes, expiresAt: worker.expiresAt,
    });
  }

  const existing = setup.episode_id ? { id: setup.episode_id, video_status: setup.video_status || '' } : null;

  // A request can time out after the D1 session is created but before the
  // Worker returns its multipart token. If the operator retries with a fresh
  // browser idempotency key, recover that exact file/session instead of
  // turning the transient edge failure into a permanent 409.
  if (existing && ['uploading', 'validating', 'processing'].includes(existing.video_status)) {
    const active: ExistingUpload | null = setup.active_id ? {
      id: setup.active_id,
      uploadId: setup.active_upload_id || '',
      objectKey: setup.active_object_key || '',
      partSizeBytes: Number(setup.active_part_size_bytes || 0),
      expiresAt: setup.active_expires_at || '',
      status: setup.active_status || '',
      media_asset_id: setup.active_media_asset_id || '',
      episode_id: setup.active_episode_id || '',
      source_file_name: setup.active_file_name || '',
      source_size_bytes: Number(setup.active_file_size || 0),
      idempotency_key: setup.active_idempotency_key || '',
      object_key: setup.active_object_key || '',
      expires_at: setup.active_expires_at || '',
      r2_completed_at: setup.active_r2_completed_at,
    } : null;
    if (active && !active.r2_completed_at && active.source_file_name === fileName && Number(active.source_size_bytes) === fileSizeBytes) {
      const worker = await mediaWorkerRequest<WorkerUpload>(event, '/uploads', {
        idempotencyKey: active.idempotency_key, sessionId: active.id, completionKey: `r2:${active.id}`,
        streamIdempotencyKey: `reelnova:upload:${active.id}`,
        objectKey: active.object_key, contentType, fileSizeBytes,
        metadata: { assetId: active.media_asset_id, episodeId: active.episode_id, seriesId },
      }, 'POST', { maxAttempts: 2, timeoutMs: 10_000 });
      const now = new Date().toISOString();
      await d1Run(event, `UPDATE media_upload_sessions SET provider_upload_id = ?, part_size_bytes = ?, expires_at = ?,
        last_error = NULL, updated_at = ? WHERE id = ?`, [worker.uploadId, worker.partSizeBytes, worker.expiresAt, now, active.id]);
      return ok({
        id: active.id, episodeId: active.episode_id, mediaAssetId: active.media_asset_id, episodeNo,
        uploadUrl: worker.uploadUrl, uploadToken: worker.uploadToken, partSizeBytes: worker.partSizeBytes, expiresAt: worker.expiresAt,
      });
    }
  }
  if (existing && ['uploading', 'validating', 'processing'].includes(existing.video_status)) {
    throw createError({ statusCode: 409, statusMessage: 'This episode already has an active media job' });
  }

  const episodeId = existing?.id || `ep_${crypto.randomUUID()}`;
  const assetId = `media_${crypto.randomUUID()}`;
  const sessionId = `upload_${crypto.randomUUID()}`;
  const safeName = `${episodeNo}-${crypto.randomUUID().slice(0, 8)}.${extension}`;
  const objectKey = `originals/${seriesId}/${episodeId}/${assetId}/${safeName}`;
  const now = new Date().toISOString();

  // Persist the episode, asset, upload session, and series state atomically.
  // D1 REST-backed deployments otherwise make several sequential network calls
  // here; an edge timeout between them can leave an episode marked uploading
  // without an idempotency session, so the next click is rejected with 409.
  const setupStatements = [];
  if (existing) {
    setupStatements.push({
      sql: `UPDATE media_assets SET status = 'superseded', deleted_at = COALESCE(deleted_at, ?), updated_at = ?
        WHERE episode_id = ? AND deleted_at IS NULL AND status <> 'superseded'`,
      params: [now, now, episodeId],
    });
    setupStatements.push({
      sql: `UPDATE episodes SET title = ?, video_status = 'uploading', active_media_asset_id = NULL,
        updated_at = ? WHERE id = ?`,
      params: [title, now, episodeId],
    });
  } else {
    setupStatements.push({
      sql: `INSERT INTO episodes
        (id, series_id, episode_no, title, duration_seconds, is_free, video_status, created_at, updated_at)
        VALUES (?, ?, ?, ?, 0, ?, 'uploading', ?, ?)`,
      params: [episodeId, seriesId, episodeNo, title, episodeNo <= series.free_episode_count ? 1 : 0, now, now],
    });
  }
  setupStatements.push({
    sql: `INSERT INTO media_assets
      (id, episode_id, kind, storage_provider, source_object_key, source_file_name, source_content_type,
       source_size_bytes, width, height, duration_seconds, has_video, has_audio, validation_status, status, created_at, updated_at)
      VALUES (?, ?, 'video', 'r2', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'uploading', ?, ?)`,
    params: [assetId, episodeId, objectKey, fileName, contentType, fileSizeBytes,
      probeValid ? width : null, probeValid ? height : null, probeValid ? durationSeconds : null,
      probeValid ? 1 : null, probeValid ? 1 : null, now, now],
  });
  setupStatements.push({
    sql: 'UPDATE episodes SET active_media_asset_id = ? WHERE id = ?',
    params: [assetId, episodeId],
  });
  setupStatements.push({
    sql: `INSERT INTO media_upload_sessions
      (id, media_asset_id, provider_upload_id, object_key, part_size_bytes, file_size_bytes, status, expires_at,
       idempotency_key, r2_completion_key, stream_idempotency_key, created_at, updated_at)
      VALUES (?, ?, ?, ?, 10485760, ?, 'created', ?, ?, ?, ?, ?, ?)`,
    params: [sessionId, assetId, `pending:${sessionId}`, objectKey, fileSizeBytes, new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      idempotencyKey, `r2:${sessionId}`, `reelnova:upload:${sessionId}`, now, now],
  });
  setupStatements.push({
    sql: `UPDATE series SET status = CASE WHEN status = 'rights_frozen' THEN status ELSE 'processing' END, updated_at = ? WHERE id = ?`,
    params: [now, seriesId],
  });
  await d1Batch(event, setupStatements);
  let worker: WorkerUpload;
  try {
    worker = await mediaWorkerRequest<WorkerUpload>(event, '/uploads', {
      idempotencyKey, sessionId, completionKey: `r2:${sessionId}`,
      streamIdempotencyKey: `reelnova:upload:${sessionId}`,
      objectKey, contentType, fileSizeBytes, metadata: { assetId, episodeId, seriesId },
    }, 'POST', { maxAttempts: 2, timeoutMs: 10_000 });
    await d1Run(event, `UPDATE media_upload_sessions SET provider_upload_id = ?, object_key = ?, part_size_bytes = ?, expires_at = ?,
      last_error = NULL, updated_at = ? WHERE id = ?`, [worker.uploadId, worker.objectKey, worker.partSizeBytes, worker.expiresAt, now, sessionId]);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Multipart upload provisioning failed';
    await d1Run(event, 'UPDATE media_upload_sessions SET last_error = ?, updated_at = ? WHERE id = ?', [message, now, sessionId]).catch(() => undefined);
    throw error;
  }
  await recordAdminAudit(event, { module: '短剧管理', action: '创建分集上传', target: `${series.title} · Episode ${episodeNo}`, detail: `${fileName} · ${fileSizeBytes} bytes` }).catch(() => undefined);
  return ok({
    id: sessionId, episodeId, mediaAssetId: assetId, episodeNo, uploadUrl: worker.uploadUrl,
    uploadToken: worker.uploadToken, partSizeBytes: worker.partSizeBytes, expiresAt: worker.expiresAt,
  });
});
