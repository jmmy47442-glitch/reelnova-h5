import { createUserAccount, setUserSession } from '../../utils/user-auth';
import { ok } from '../../utils/response';

export default defineEventHandler(async (event) => {
  const body = await readBody<{ name?: string; email?: string; password?: string; remember?: boolean }>(event);
  const name = body.name?.trim() || '';
  const email = body.email?.trim().toLowerCase() || '';
  const password = body.password || '';
  if (name.length < 2 || name.length > 40) throw createError({ statusCode: 400, statusMessage: 'Name must be between 2 and 40 characters' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw createError({ statusCode: 400, statusMessage: 'Enter a valid email address' });
  if (password.length < 8 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    throw createError({ statusCode: 400, statusMessage: 'Password must contain at least 8 characters, including a letter and number' });
  }
  const account = await createUserAccount(event, { name, email, password });
  return ok(await setUserSession(event, account, body.remember !== false));
});
