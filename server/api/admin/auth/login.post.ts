import { authenticateAdmin, setAdminSession } from '../../../utils/admin-auth';
import { ok } from '../../../utils/response';

export default defineEventHandler(async (event) => {
  const body = await readBody<{ email?: string; password?: string; remember?: boolean }>(event);
  const email = body.email?.trim().toLowerCase() || '';
  const password = body.password || '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 8) {
    throw createError({ statusCode: 400, statusMessage: 'Valid email and password are required' });
  }

  const account = await authenticateAdmin(event, email, password);
  if (!account) throw createError({ statusCode: 401, statusMessage: 'Invalid administrator credentials' });
  const session = await setAdminSession(event, account, body.remember !== false);
  return ok(session);
});
