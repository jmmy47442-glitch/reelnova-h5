import { createUserAccount, setUserSession } from '../../utils/user-auth';
import { ok } from '../../utils/response';

export default defineEventHandler(async (event) => {
  const body = await readBody<{
    name?: string;
    email?: string;
    password?: string;
    passwordSalt?: string;
    passwordHash?: string;
    remember?: boolean;
  }>(event);
  const name = body.name?.trim() || '';
  const email = body.email?.trim().toLowerCase() || '';
  const password = body.password || '';
  if (name.length < 2 || name.length > 40) throw createError({ statusCode: 400, statusMessage: 'Name must be between 2 and 40 characters' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw createError({ statusCode: 400, statusMessage: 'Enter a valid email address' });
  if (password.length < 8 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    throw createError({ statusCode: 400, statusMessage: 'Password must contain at least 8 characters, including a letter and number' });
  }
  if (!/^[A-Za-z0-9_-]{24}$/.test(body.passwordSalt || '') || !/^[A-Za-z0-9_-]{43}$/.test(body.passwordHash || '')) {
    throw createError({ statusCode: 400, statusMessage: 'Valid password credentials are required' });
  }
  const account = await createUserAccount(event, {
    name,
    email,
    passwordSalt: body.passwordSalt!,
    passwordHash: body.passwordHash!,
  });
  return ok(await setUserSession(event, account, body.remember !== false));
});
