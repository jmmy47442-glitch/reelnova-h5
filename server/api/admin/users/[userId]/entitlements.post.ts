import { ok } from '~/server/utils/response';
import { d1First, d1Run } from '~/server/utils/cloudflare-d1';
import { recordAdminUserAction } from '~/server/utils/user-profile';
import { getManagedSeries } from '~/server/utils/managed-content';

export default defineEventHandler(async (event) => {
  const userId = getRouterParam(event, 'userId') || '';
  const body = await readBody<{ seriesId?: string; reason?: string }>(event);
  const seriesList = await getManagedSeries(event);
  const reason = body?.reason?.trim() || '';
  const series = seriesList.find((item) => item.id === body?.seriesId);
  if (!userId || !series || !reason || reason.length > 200) {
    throw createError({ statusCode: 400, statusMessage: 'Valid series and reason are required' });
  }
  const user = await d1First<{ user_id: string }>(event, 'SELECT user_id FROM users WHERE user_id = ?', [userId]);
  if (!user) throw createError({ statusCode: 404, statusMessage: 'User not found' });
  const paid = await d1First<{ id: string }>(event, "SELECT id FROM entitlements WHERE user_id = ? AND series_id = ? AND status = 'granted'", [userId, series.id]);
  if (paid) throw createError({ statusCode: 409, statusMessage: 'User already has this paid entitlement' });
  const openCheckout = await d1First<{ order_no: string }>(event, `SELECT order_no FROM orders
    WHERE user_id = ? AND series_id = ? AND status IN ('pending', 'processing') LIMIT 1`, [userId, series.id]);
  if (openCheckout) throw createError({
    statusCode: 409,
    statusMessage: 'Manual entitlement cannot be granted while the user has an open checkout',
    data: { code: 'OPEN_CHECKOUT_EXISTS', orderNo: openCheckout.order_no },
  });
  const now = new Date().toISOString();
  const session = event.context.adminSession as { email?: string } | undefined;
  const actor = getHeader(event, 'cf-access-authenticated-user-email') || session?.email || 'Admin';
  await d1Run(event, `INSERT INTO manual_entitlements
    (id, user_id, series_id, series_title, status, reason, granted_by, granted_at)
    VALUES (?, ?, ?, ?, 'granted', ?, ?, ?)
    ON CONFLICT(user_id, series_id) DO UPDATE SET
      series_title = excluded.series_title, status = 'granted', reason = excluded.reason,
      granted_by = excluded.granted_by, granted_at = excluded.granted_at, revoked_at = NULL`,
  [crypto.randomUUID(), userId, series.id, series.title, reason, actor, now]);
  await recordAdminUserAction(event, { userId, action: 'entitlement_grant', detail: `${series.id}: ${series.title}; reason: ${reason}` });
  return ok({ userId, seriesId: series.id, status: 'granted' as const });
});
