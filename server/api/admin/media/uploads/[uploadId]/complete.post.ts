import type { MediaUploadPart } from '~/types/admin';
import { completeMediaUpload, getMediaUploadState } from '~/server/utils/media-upload-state';
import { ok } from '~/server/utils/response';

export default defineEventHandler(async (event) => {
  const uploadId = getRouterParam(event, 'uploadId') || '';
  const body = await readBody<{ parts?: MediaUploadPart[] }>(event);
  const upload = await getMediaUploadState(event, uploadId);
  if (!upload) throw createError({ statusCode: 404, statusMessage: 'Upload session not found' });
  return ok(await completeMediaUpload(event, upload, Array.isArray(body?.parts) ? body.parts : []));
});
