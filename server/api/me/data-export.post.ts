import { ok } from '~/server/utils/response';
import { d1All, d1First, d1Run } from '~/server/utils/cloudflare-d1';
import { getUserSession } from '~/server/utils/user-auth';
import type { AccountDataExport, AccountSettings } from '~/types/user';

export default defineEventHandler(async (event) => {
  const session = await getUserSession(event);
  if (!session) throw createError({ statusCode: 401, statusMessage: 'Login required' });
  const requestedAt = new Date().toISOString();
  const requestId = `privacy_${crypto.randomUUID()}`;
  await d1Run(event, `INSERT INTO privacy_requests
    (id, user_id, request_type, status, requested_at) VALUES (?, ?, 'export', 'processing', ?)`,
  [requestId, session.userId, requestedAt]);

  try {
    const [account, preference, watchHistory, orders, entitlements, refunds] = await Promise.all([
      d1First<Record<string, unknown>>(event, `SELECT user_id AS userId, email, display_name AS name,
        country, device, status, created_at AS createdAt, last_seen_at AS lastSeenAt
        FROM users WHERE user_id = ?`, [session.userId]),
      d1First<{ language: AccountSettings['language']; recommendations: number; analytics: number; marketing: number; updated_at: string }>(event,
        'SELECT language, recommendations, analytics, marketing, updated_at FROM user_preferences WHERE user_id = ?', [session.userId]),
      d1All<Record<string, unknown>>(event, `SELECT wh.series_id AS seriesId,
        COALESCE((SELECT pe.series_title FROM playback_events pe WHERE pe.user_id = wh.user_id AND pe.series_id = wh.series_id ORDER BY pe.created_at DESC LIMIT 1), wh.series_id) AS seriesTitle,
        wh.episode_no AS episodeNo, wh.position_seconds AS positionSeconds,
        wh.duration_seconds AS durationSeconds, wh.completed, wh.last_watched_at AS lastWatchedAt
        FROM watch_history wh WHERE wh.user_id = ? ORDER BY wh.last_watched_at DESC`, [session.userId]),
      d1All<Record<string, unknown>>(event, `SELECT order_no AS orderNo, series_id AS seriesId, series_title AS seriesTitle,
        amount_cents AS amountCents, currency, status, paypal_order_id AS paypalOrderId,
        capture_id AS captureId, created_at AS createdAt, callback_at AS callbackAt
        FROM orders WHERE user_id = ? ORDER BY created_at DESC`, [session.userId]),
      d1All<Record<string, unknown>>(event, `SELECT series_id AS seriesId, order_no AS orderNo, status,
        granted_at AS grantedAt, revoked_at AS revokedAt FROM entitlements WHERE user_id = ?
        UNION ALL SELECT series_id AS seriesId, NULL AS orderNo, status,
        granted_at AS grantedAt, revoked_at AS revokedAt FROM manual_entitlements WHERE user_id = ?`, [session.userId, session.userId]),
      d1All<Record<string, unknown>>(event, `SELECT rr.id, rr.order_no AS orderNo, rr.amount_cents AS amountCents,
        rr.currency, rr.status, rr.request_source AS source, rr.reason,
        rr.created_at AS createdAt, rr.completed_at AS completedAt
        FROM refund_requests rr JOIN orders o ON o.order_no = rr.order_no
        WHERE o.user_id = ? ORDER BY rr.created_at DESC`, [session.userId]),
    ]);
    if (!account) throw createError({ statusCode: 404, statusMessage: 'Account not found' });
    const completedAt = new Date().toISOString();
    await d1Run(event, `UPDATE privacy_requests SET status = 'completed',
      detail = ?, completed_at = ? WHERE id = ?`, [
      JSON.stringify({ watchHistory: watchHistory.length, orders: orders.length, entitlements: entitlements.length, refunds: refunds.length }),
      completedAt, requestId,
    ]);
    return ok<AccountDataExport>({
      requestId,
      exportedAt: completedAt,
      account: account as AccountDataExport['account'],
      settings: {
        language: preference?.language || 'en',
        recommendations: preference ? Boolean(preference.recommendations) : true,
        analytics: preference ? Boolean(preference.analytics) : true,
        marketing: preference ? Boolean(preference.marketing) : false,
        updatedAt: preference?.updated_at || null,
      },
      watchHistory,
      orders,
      entitlements,
      refunds,
    });
  } catch (error) {
    await d1Run(event, `UPDATE privacy_requests SET status = 'failed', detail = ?, completed_at = ? WHERE id = ?`,
      [error instanceof Error ? error.message : 'Export failed', new Date().toISOString(), requestId]).catch(() => undefined);
    throw error;
  }
});
