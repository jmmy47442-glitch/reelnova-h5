import { authenticateUserProof, setUserSession } from '../../utils/user-auth';
import { ok } from '../../utils/response';

export default defineEventHandler(async (event) => {
  const body = await readBody<{ email?: string; challenge?: string; proof?: string; remember?: boolean }>(event);
  const email = body.email?.trim().toLowerCase() || '';
  const challenge = body.challenge || '';
  const proof = body.proof || '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || challenge.length > 1_024 || !/^[A-Za-z0-9_-]{43}$/.test(proof)) {
    throw createError({ statusCode: 400, statusMessage: 'Valid account credentials are required' });
  }
  const account = await authenticateUserProof(event, email, challenge, proof);
  if (!account) throw createError({ statusCode: 401, statusMessage: 'Invalid email or password' });
  return ok(await setUserSession(event, account, body.remember !== false));
});
