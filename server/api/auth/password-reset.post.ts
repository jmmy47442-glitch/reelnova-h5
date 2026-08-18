import { resetUserPassword } from '../../utils/user-auth';
import { ok } from '../../utils/response';

export default defineEventHandler(async (event) => {
  const body = await readBody<{ email?: string; password?: string }>(event);
  const email = body.email?.trim().toLowerCase() || '';
  const password = body.password || '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw createError({ statusCode: 400, statusMessage: 'Enter a valid email address' });
  if (password.length < 8 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    throw createError({ statusCode: 400, statusMessage: 'Password must contain at least 8 characters, including a letter and number' });
  }
  const account = await resetUserPassword(event, email, password);
  if (!account) throw createError({ statusCode: 404, statusMessage: 'No account with this email was found' });
  return ok({ email: account.email });
});
