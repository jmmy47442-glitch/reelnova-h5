import { getAdminSession } from '../../../utils/admin-auth';
import { ok } from '../../../utils/response';

export default defineEventHandler(async (event) => {
  const session = await getAdminSession(event);
  if (!session) throw createError({ statusCode: 401, statusMessage: 'Admin login required' });
  return ok(session);
});
