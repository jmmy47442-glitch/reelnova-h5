import { resetUserPassword } from '../../utils/user-auth';
import { ok } from '../../utils/response';

export default defineEventHandler(async (event) => {
  const body = await readBody<{ email?: string; password?: string; passwordSalt?: string; passwordHash?: string; challenge?: string; proof?: string }>(event);
  const email = body.email?.trim().toLowerCase() || '';
  const password = body.password || '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw createError({ statusCode: 400, statusMessage: 'Enter a valid email address' });
  if (password.length < 8 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    throw createError({ statusCode: 400, statusMessage: 'Password must contain at least 8 characters, including a letter and number' });
  }
  if (!/^[A-Za-z0-9_-]{24}$/.test(body.passwordSalt || '') || !/^[A-Za-z0-9_-]{43}$/.test(body.passwordHash || '')) {
    throw createError({ statusCode: 400, statusMessage: 'Valid password credentials are required' });
  }
  if ((body.challenge?.length || 0) > 1_024 || !body.challenge || !/^[A-Za-z0-9_-]{43}$/.test(body.proof || '')) {
    throw createError({ statusCode: 400, statusMessage: 'A valid password reset challenge is required' });
  }
  const account = await resetUserPassword(event, email, body.passwordSalt!, body.passwordHash!, body.challenge, body.proof!);
  if (!account) throw createError({ statusCode: 404, statusMessage: 'No account with this email was found' });
  return ok({ email: account.email });
});
