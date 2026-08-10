import { ok } from '~/server/utils/response';
import { d1First, d1Run } from '~/server/utils/cloudflare-d1';
import { recordAdminUserAction } from '~/server/utils/user-profile';
import type { PersistedUserStatus } from '~/types/admin';

export default defineEventHandler(async (event) => {
  const userId = getRouterParam(event, 'userId') || '';
  const body = await readBody<{ status?: PersistedUserStatus }>(event);
  if (!userId) throw createError({ statusCode: 400, statusMessage: 'User ID is required' });
  if (!body?.status || !['active', 'restricted', 'disabled'].includes(body.status)) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid user status' });
  }
  const existing = await d1First<{ user_id: string; status: PersistedUserStatus }>(event, 'SELECT user_id, status FROM users WHERE user_id = ?', [userId]);
  if (!existing) throw createError({ statusCode: 404, statusMessage: 'User not found' });
  await d1Run(event, 'UPDATE users SET status = ?, updated_at = ? WHERE user_id = ?', [body.status, new Date().toISOString(), userId]);
  await recordAdminUserAction(event, { userId, action: 'status_change', detail: `${existing.status} -> ${body.status}` });
  return ok({ userId, status: body.status });
});
