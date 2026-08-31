import { createUserLoginChallenge } from '../../utils/user-auth';
import { ok } from '../../utils/response';

export default defineEventHandler(async (event) => {
  const body = await readBody<{ email?: string; purpose?: 'login' | 'reset' }>(event);
  const email = body.email?.trim().toLowerCase() || '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw createError({ statusCode: 400, statusMessage: 'Enter a valid email address' });
  }
  return ok(await createUserLoginChallenge(event, email, body.purpose === 'reset' ? 'reset' : 'login'));
});
