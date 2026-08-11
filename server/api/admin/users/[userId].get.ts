import { ok } from '~/server/utils/response';
import { d1All, d1First } from '~/server/utils/cloudflare-d1';
import type { AdminUserDetail, PersistedOrder, PersistedUserStatus } from '~/types/admin';

interface ProfileRow {
  user_id: string; display_name: string; email: string | null; country: string | null; device: string | null;
  status: PersistedUserStatus; created_at: string; last_seen_at: string; orders: number; entitlements: number;
  language: string | null; recommendations: number | null; analytics: number | null; marketing: number | null;
}
interface OrderRow {
  order_no: string; series_id: string; series_title: string; email: string | null; country: string | null;
  amount_cents: number; fee_cents: number; status: PersistedOrder['status']; paypal_order_id: string | null;
  capture_id: string | null; created_at: string; callback_at: string | null; note: string | null; entitlement_status: string | null;
  refund_status: PersistedOrder['refund']['status']; paypal_refund_id: string | null; refund_source: PersistedOrder['refund']['source'];
  entitlement_revoke_status: PersistedOrder['refund']['entitlementRevokeStatus']; refund_error_message: string | null; refund_updated_at: string | null;
}

const maskEmail = (value: string | null) => {
  if (!value) return '—';
  const [local, domain] = value.split('@');
  return local && domain ? `${local.slice(0, Math.min(2, local.length))}***@${domain}` : '—';
};
const mapOrder = (row: OrderRow): PersistedOrder => ({
  orderNo: row.order_no, seriesId: row.series_id, seriesTitle: row.series_title,
  email: row.email ? maskEmail(row.email) : null, country: row.country,
  amount: Number(row.amount_cents) / 100, currency: 'USD', fee: Number(row.fee_cents) / 100,
  netAmount: (Number(row.amount_cents) - Number(row.fee_cents)) / 100, status: row.status,
  paypalOrderId: row.paypal_order_id, captureId: row.capture_id, createdAt: row.created_at,
  callbackAt: row.callback_at,
  entitlement: row.entitlement_status === 'granted' ? 'granted' : row.entitlement_status === 'revoked' ? 'revoked' : 'pending',
  refund: {
    status: row.refund_status || null, paypalRefundId: row.paypal_refund_id,
    source: row.refund_source || null, entitlementRevokeStatus: row.entitlement_revoke_status || null,
    errorMessage: row.refund_error_message, updatedAt: row.refund_updated_at,
  },
  note: row.note,
});

export default defineEventHandler(async (event) => {
  const userId = getRouterParam(event, 'userId');
  if (!userId) throw createError({ statusCode: 400, statusMessage: 'User ID is required' });
  const profile = await d1First<ProfileRow>(event, `SELECT u.user_id, u.display_name, u.email, u.country, u.device,
    u.status, u.created_at, u.last_seen_at,
    COALESCE(p.language, 'en') AS language, COALESCE(p.recommendations, 1) AS recommendations,
    COALESCE(p.analytics, 1) AS analytics, COALESCE(p.marketing, 0) AS marketing,
    (SELECT COUNT(*) FROM orders o WHERE o.user_id = u.user_id) AS orders,
    (SELECT COUNT(*) FROM (
      SELECT series_id FROM entitlements e WHERE e.user_id = u.user_id AND e.status = 'granted'
      UNION SELECT series_id FROM manual_entitlements m WHERE m.user_id = u.user_id AND m.status = 'granted'
    )) AS entitlements
    FROM users u LEFT JOIN user_preferences p ON p.user_id = u.user_id
    WHERE u.user_id = ? AND u.password_hash IS NOT NULL`, [userId]);
  if (!profile) throw createError({ statusCode: 404, statusMessage: 'User not found' });

  const [entitlements, history, orderRows] = await Promise.all([
    d1All<AdminUserDetail['entitlements'][number]>(event, `SELECT e.series_id AS seriesId, o.series_title AS seriesTitle,
      'order' AS source, e.status, e.granted_at AS grantedAt, e.revoked_at AS revokedAt
      FROM entitlements e JOIN orders o ON o.order_no = e.order_no WHERE e.user_id = ?
      UNION ALL SELECT m.series_id AS seriesId, m.series_title AS seriesTitle,
      'manual' AS source, m.status, m.granted_at AS grantedAt, m.revoked_at AS revokedAt
      FROM manual_entitlements m WHERE m.user_id = ? ORDER BY grantedAt DESC`, [userId, userId]),
    d1All<AdminUserDetail['watchHistory'][number]>(event, `SELECT wh.series_id AS seriesId,
      COALESCE((SELECT pe.series_title FROM playback_events pe WHERE pe.user_id = wh.user_id AND pe.series_id = wh.series_id ORDER BY pe.created_at DESC LIMIT 1), wh.series_id) AS seriesTitle,
      wh.episode_no AS episodeNo, wh.position_seconds AS positionSeconds,
      wh.duration_seconds AS durationSeconds, wh.completed,
      wh.last_watched_at AS lastWatchedAt FROM watch_history wh
      WHERE wh.user_id = ? ORDER BY wh.last_watched_at DESC LIMIT 100`, [userId]),
    d1All<OrderRow>(event, `SELECT o.*, e.status AS entitlement_status,
      rr.status AS refund_status, rr.paypal_refund_id, rr.request_source AS refund_source,
      rr.entitlement_revoke_status, rr.error_message AS refund_error_message, rr.updated_at AS refund_updated_at
      FROM orders o LEFT JOIN entitlements e ON e.order_no = o.order_no
      LEFT JOIN refund_requests rr ON rr.order_no = o.order_no
        AND rr.created_at = (SELECT MAX(rr2.created_at) FROM refund_requests rr2 WHERE rr2.order_no = o.order_no)
      WHERE o.user_id = ? ORDER BY o.created_at DESC LIMIT 100`, [userId]),
  ]);
  return ok<AdminUserDetail>({
    profile: {
      id: profile.user_id, name: profile.display_name, email: maskEmail(profile.email),
      country: profile.country || '—', device: profile.device || '未知设备', status: profile.status,
      entitlements: Number(profile.entitlements || 0), orders: Number(profile.orders || 0),
      lastSeenAt: profile.last_seen_at, createdAt: profile.created_at,
      language: profile.language || 'en',
      privacy: { recommendations: Boolean(profile.recommendations), analytics: Boolean(profile.analytics), marketing: Boolean(profile.marketing) },
    },
    entitlements,
    watchHistory: history.map((item) => ({ ...item, completed: Boolean(item.completed) })),
    orders: orderRows.map(mapOrder),
  });
});
