import { listAdminAccounts, requireSuperAdmin } from '../../../utils/admin-auth';
import { ok } from '../../../utils/response';

export default defineEventHandler(async (event) => {
  requireSuperAdmin(event);
  return ok({ items: await listAdminAccounts(event) });
});
