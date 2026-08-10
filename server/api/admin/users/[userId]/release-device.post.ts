import { ok } from '~/server/utils/response';
import { d1First, d1Run } from '~/server/utils/cloudflare-d1';
import { recordAdminUserAction } from '~/server/utils/user-profile';

export default defineEventHandler(async (event) => {
  const userId = getRouterParam(event, 'userId') || '';
  const existing = await d1First<{ status: string }>(event, 'SELECT status FROM users WHERE user_id = ?', [userId]);
  if (!existing) throw createError({ statusCode: 404, statusMessage: 'User not found' });
  const now = new Date().toISOString();
  await d1Run(event, "UPDATE users SET status = CASE WHEN status = 'restricted' THEN 'active' ELSE status END, updated_at = ? WHERE user_id = ?", [now, userId]);
  await recordAdminUserAction(event, { userId, action: 'device_restriction_release', detail: `Previous status: ${existing.status}` });
  return ok({ userId, status: existing.status === 'restricted' ? 'active' : existing.status });
});
