import { ok } from '~/server/utils/response';
import { persistAuthorizedPlaybackEvent } from '~/server/utils/watch-history';
import type { PlaybackEventInput } from '~/types/content';

export default defineEventHandler(async (event) => {
  const body = await readBody<PlaybackEventInput>(event);
  return ok(await persistAuthorizedPlaybackEvent(event, body));
});
