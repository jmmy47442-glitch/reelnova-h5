import { ok } from '~/server/utils/response';
import { d1First, d1Run } from '~/server/utils/cloudflare-d1';
import { recordAdminUserAction } from '~/server/utils/user-profile';
import type { PersistedUserStatus } from '~/types/admin';

export default defineEventHandler(async (event) => {
  const visitorId = getRouterParam(event, 'visitorId') || '';
  const body = await readBody<{ status?: PersistedUserStatus }>(event);
  if (!visitorId) throw createError({ statusCode: 400, statusMessage: 'Visitor ID is required' });
  if (!body?.status || !['active', 'restricted', 'disabled'].includes(body.status)) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid user status' });
  }
  const existing = await d1First<{ visitor_id: string; status: PersistedUserStatus }>(event, 'SELECT visitor_id, status FROM users WHERE visitor_id = ?', [visitorId]);
  if (!existing) throw createError({ statusCode: 404, statusMessage: 'User not found' });
  await d1Run(event, 'UPDATE users SET status = ?, updated_at = ? WHERE visitor_id = ?', [body.status, new Date().toISOString(), visitorId]);
  await recordAdminUserAction(event, { visitorId, action: 'status_change', detail: `${existing.status} -> ${body.status}` });
  return ok({ visitorId, status: body.status });
});
