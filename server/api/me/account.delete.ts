import { ok } from '~/server/utils/response';
import { clearUserSession, getUserSession } from '~/server/utils/user-auth';
import { d1Run } from '~/server/utils/cloudflare-d1';

export default defineEventHandler(async (event) => {
  const session = await getUserSession(event);
  if (!session) throw createError({ statusCode: 401, statusMessage: 'Login required' });
  const body = await readBody<{ email?: string; confirmation?: string }>(event);
  if (body.email?.trim().toLowerCase() !== session.email.toLowerCase() || body.confirmation !== 'DELETE') {
    throw createError({ statusCode: 400, statusMessage: 'Email and DELETE confirmation are required' });
  }

  const now = new Date().toISOString();
  const requestId = `privacy_${crypto.randomUUID()}`;
  await d1Run(event, `INSERT INTO privacy_requests
    (id, user_id, request_type, status, requested_at) VALUES (?, ?, 'deletion', 'processing', ?)`,
  [requestId, session.userId, now]);
  try {
    await d1Run(event, 'DELETE FROM watch_history WHERE user_id = ?', [session.userId]);
    await d1Run(event, 'DELETE FROM playback_events WHERE user_id = ?', [session.userId]);
    await d1Run(event, `UPDATE entitlements SET status = 'revoked', revoked_at = COALESCE(revoked_at, ?) WHERE user_id = ?`, [now, session.userId]);
    await d1Run(event, `UPDATE manual_entitlements SET status = 'revoked', revoked_at = COALESCE(revoked_at, ?) WHERE user_id = ?`, [now, session.userId]);
    await d1Run(event, 'DELETE FROM user_preferences WHERE user_id = ?', [session.userId]);
    await d1Run(event, 'UPDATE orders SET email = NULL, country = NULL, updated_at = ? WHERE user_id = ?', [now, session.userId]);
    await d1Run(event, `UPDATE users SET email = NULL, display_name = 'Deleted account',
      password_salt = NULL, password_hash = NULL, country = NULL, device = NULL,
      status = 'disabled', updated_at = ?, last_seen_at = ? WHERE user_id = ?`, [now, now, session.userId]);
    await d1Run(event, `UPDATE privacy_requests SET status = 'completed', detail = ?, completed_at = ? WHERE id = ?`, [
      'Account identifiers and activity deleted; financial records retained without email or country.', now, requestId,
    ]);
    clearUserSession(event);
    return ok({ requestId, deletedAt: now, retained: ['anonymized orders', 'refund records', 'privacy request audit'] });
  } catch (error) {
    await d1Run(event, `UPDATE privacy_requests SET status = 'failed', detail = ?, completed_at = ? WHERE id = ?`,
      [error instanceof Error ? error.message : 'Deletion failed', new Date().toISOString(), requestId]).catch(() => undefined);
    throw error;
  }
});
