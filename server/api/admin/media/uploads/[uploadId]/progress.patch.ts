import { ok } from '~/server/utils/response';
import { d1First, d1Run } from '~/server/utils/cloudflare-d1';

export default defineEventHandler(async (event) => {
  const uploadId = getRouterParam(event, 'uploadId') || '';
  const body = await readBody<{ uploadedBytes?: unknown }>(event);
  const uploadedBytes = Number(body?.uploadedBytes);
  const session = await d1First<{ file_size_bytes: number; status: string }>(event,
    'SELECT file_size_bytes, status FROM media_upload_sessions WHERE id = ?', [uploadId]);
  if (!session) throw createError({ statusCode: 404, statusMessage: 'Upload session not found' });
  if (!Number.isSafeInteger(uploadedBytes) || uploadedBytes < 0 || uploadedBytes > session.file_size_bytes) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid upload progress' });
  }
  const now = new Date().toISOString();
  await d1Run(event, `UPDATE media_upload_sessions SET uploaded_bytes = MAX(uploaded_bytes, ?), status = 'uploading', updated_at = ?
    WHERE id = ? AND status IN ('created', 'uploading')`, [uploadedBytes, now, uploadId]);
  return ok({ uploadedBytes, fileSizeBytes: session.file_size_bytes });
});
