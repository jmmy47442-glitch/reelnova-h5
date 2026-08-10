import { ok } from '~/server/utils/response';
import { d1First, d1Run } from '~/server/utils/cloudflare-d1';
import { recordAdminUserAction } from '~/server/utils/user-profile';

export default defineEventHandler(async (event) => {
  const visitorId = getRouterParam(event, 'visitorId') || '';
  const existing = await d1First<{ status: string }>(event, 'SELECT status FROM users WHERE visitor_id = ?', [visitorId]);
  if (!existing) throw createError({ statusCode: 404, statusMessage: 'User not found' });
  const now = new Date().toISOString();
  await d1Run(event, "UPDATE users SET status = CASE WHEN status = 'restricted' THEN 'active' ELSE status END, updated_at = ? WHERE visitor_id = ?", [now, visitorId]);
  await recordAdminUserAction(event, { visitorId, action: 'device_restriction_release', detail: `Previous status: ${existing.status}` });
  return ok({ visitorId, status: existing.status === 'restricted' ? 'active' : existing.status });
});
