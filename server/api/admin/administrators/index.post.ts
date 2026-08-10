import { createAdminAccount, requireSuperAdmin } from '../../../utils/admin-auth';
import { ok } from '../../../utils/response';

export default defineEventHandler(async (event) => {
  const session = requireSuperAdmin(event);
  const body = await readBody<{ email?: string; name?: string }>(event);
  const email = body.email?.trim().toLowerCase() || '';
  const name = body.name?.trim() || '';
  if (!name || name.length > 80) throw createError({ statusCode: 400, statusMessage: 'Administrator name is required' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    throw createError({ statusCode: 400, statusMessage: 'Valid administrator email is required' });
  }
  return ok(await createAdminAccount(event, { email, name, createdBy: session.id }));
});
