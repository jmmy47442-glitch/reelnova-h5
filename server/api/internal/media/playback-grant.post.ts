import { ok } from '~/server/utils/response';
import { verifyStreamTokenGrant } from '~/server/utils/playback-authorization';

export default defineEventHandler(async (event) => {
  const body = await readBody<{ uid?: string; exp?: number; grant?: string }>(event);
  const uid = String(body.uid || '');
  const exp = Math.floor(Number(body.exp));
  const grant = String(body.grant || '');
  if (!/^[0-9a-f]{32}$/i.test(uid) || !await verifyStreamTokenGrant(event, uid, exp, grant)) {
    throw createError({ statusCode: 401, statusMessage: 'Invalid Stream playback grant' });
  }
  return ok({ authorized: true, uid, expires: exp });
});
