import { deleteAdminAccount, requireSuperAdmin } from '../../../utils/admin-auth';
import { ok } from '../../../utils/response';

export default defineEventHandler(async (event) => {
  requireSuperAdmin(event);
  const id = getRouterParam(event, 'id') || '';
  if (!id) throw createError({ statusCode: 400, statusMessage: 'Administrator id is required' });
  return ok(await deleteAdminAccount(event, id));
});
