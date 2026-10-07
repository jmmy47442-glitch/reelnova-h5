import type { H3Event } from 'h3';
import type { MediaUploadPart } from '~/types/admin';
import { completeMediaUpload, getMediaUploadState, prepareMediaUploadCompletion } from '~/server/utils/media-upload-state';
import { ok } from '~/server/utils/response';

type WaitUntilContext = { waitUntil?: (promise: Promise<unknown>) => void };

const scheduleCompletion = (event: H3Event, task: Promise<unknown>) => {
  const cloudflare = event?.context?.cloudflare as (WaitUntilContext & { ctx?: WaitUntilContext; context?: WaitUntilContext; executionCtx?: WaitUntilContext }) | undefined;
  const target = [
    event,
    event?.context,
    cloudflare,
    cloudflare?.ctx,
    cloudflare?.context,
    cloudflare?.executionCtx,
  ].find((candidate) => typeof candidate?.waitUntil === 'function');
  if (!target?.waitUntil) return false;
  target.waitUntil(task);
  return true;
};

export default defineEventHandler(async (event) => {
  const uploadId = getRouterParam(event, 'uploadId') || '';
  const body = await readBody<{ parts?: MediaUploadPart[] }>(event);
  const upload = await getMediaUploadState(event, uploadId);
  if (!upload) throw createError({ statusCode: 404, statusMessage: 'Upload session not found' });
  const prepared = await prepareMediaUploadCompletion(event, upload, Array.isArray(body?.parts) ? body.parts : []);
  if (prepared.alreadyCompleted) return ok(prepared.alreadyCompleted);

  // Do not keep the browser request open while R2 completes the multipart and
  // Cloudflare Stream creates the transcode. Pages/Workers may return a 502
  // when that upstream call outlives the edge request budget. The completion
  // state and parts are already durable, and the scheduled task is idempotent.
  const task = completeMediaUpload(event, prepared.upload, [], true).catch(() => undefined);
  if (scheduleCompletion(event, task)) {
    setResponseStatus(event, 202);
    return ok({ uploadId: prepared.upload.id, mediaAssetId: prepared.upload.media_asset_id,
      streamUid: prepared.upload.stream_uid, status: 'completing' as const });
  }

  // Node/local runtimes do not expose waitUntil. Keep the synchronous fallback
  // so local development and non-Cloudflare deployments retain their behavior.
  return ok(await task);
});
