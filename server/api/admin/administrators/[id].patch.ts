import { requireSuperAdmin, updateAdminStatus } from '../../../utils/admin-auth';
import { ok } from '../../../utils/response';

export default defineEventHandler(async (event) => {
  requireSuperAdmin(event);
  const id = getRouterParam(event, 'id') || '';
  const body = await readBody<{ status?: 'active' | 'disabled' }>(event);
  if (!id || !body.status || !['active', 'disabled'].includes(body.status)) {
    throw createError({ statusCode: 400, statusMessage: 'Valid administrator status is required' });
  }
  return ok(await updateAdminStatus(event, id, body.status));
});
