import { getMediaUploadState } from '~/server/utils/media-upload-state';
import { ok } from '~/server/utils/response';

export default defineEventHandler(async (event) => {
  const uploadId = getRouterParam(event, 'uploadId') || '';
  const upload = await getMediaUploadState(event, uploadId);
  if (!upload) throw createError({ statusCode: 404, statusMessage: 'Upload session not found' });
  return ok({
    uploadId: upload.id,
    mediaAssetId: upload.media_asset_id,
    status: upload.status,
    uploadedBytes: Number(upload.uploaded_bytes),
    fileSizeBytes: Number(upload.file_size_bytes),
    r2Completed: Boolean(upload.r2_completed_at),
    streamUid: upload.stream_uid,
    recoverable: upload.status === 'completing' && Boolean(upload.completion_parts_json),
    errorMessage: upload.last_error,
    updatedAt: upload.reconciled_at,
  });
});
