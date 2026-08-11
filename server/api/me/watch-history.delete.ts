import { ok } from '~/server/utils/response';
import { d1Run } from '~/server/utils/cloudflare-d1';
import { getUserSession } from '~/server/utils/user-auth';

export default defineEventHandler(async (event) => {
  const session = await getUserSession(event);
  if (!session) throw createError({ statusCode: 401, statusMessage: 'Login required' });
  await d1Run(event, 'DELETE FROM watch_history WHERE user_id = ?', [session.userId]);
  return ok({ cleared: true });
});
