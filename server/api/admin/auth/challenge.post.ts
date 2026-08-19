import { createAdminLoginChallenge } from '../../../utils/admin-auth';
import { ok } from '../../../utils/response';

export default defineEventHandler(async (event) => {
  const body = await readBody<{ email?: string }>(event);
  const email = body.email?.trim().toLowerCase() || '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw createError({ statusCode: 400, statusMessage: 'Valid administrator email is required' });
  }
  return ok(await createAdminLoginChallenge(event, email));
});
