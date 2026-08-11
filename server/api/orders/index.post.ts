import { ok } from '~/server/utils/response';
import { d1First, d1Run, getRequestCountry } from '~/server/utils/cloudflare-d1';
import { createPayPalOrder, requirePayPalConfiguration } from '~/server/utils/paypal';
import { assertUserEnabled, upsertUserProfile } from '~/server/utils/user-profile';
import { getUserSession } from '~/server/utils/user-auth';
import { getPublicSeries } from '~/server/utils/managed-content';
import type { Order } from '~/types/content';

export default defineEventHandler(async (event) => {
  const userSession = await getUserSession(event);
  if (!userSession) {
    throw createError({
      statusCode: 401,
      statusMessage: 'Sign in or register before purchasing a series',
      data: { code: 'AUTH_REQUIRED_FOR_PURCHASE' },
    });
  }
  const body = await readBody<{ seriesId: string; idempotencyKey?: string }>(event);
  const idempotencyKey = body?.idempotencyKey?.trim().slice(0, 100) || null;
  const seriesList = await getPublicSeries(event);
  const series = seriesList.find((item) => item.id === body.seriesId);
  if (!series) throw createError({ statusCode: 404, statusMessage: 'Series not found' });
  if (series.price <= 0) throw createError({ statusCode: 400, statusMessage: 'Free series does not require checkout' });
  const now = new Date();
  const userId = userSession.userId;
  await upsertUserProfile(event, { userId });
  await assertUserEnabled(event, userId);

  const entitlement = await d1First<{ order_no: string }>(event, `SELECT order_no FROM entitlements
    WHERE user_id = ? AND series_id = ? AND status = 'granted' LIMIT 1`, [userId, series.id]);
  const manualEntitlement = await d1First<{ id: string }>(event, `SELECT id FROM manual_entitlements
    WHERE user_id = ? AND series_id = ? AND status = 'granted' LIMIT 1`, [userId, series.id]);
  if (entitlement || manualEntitlement) {
    const entitlementOrderNo = entitlement?.order_no || `MANUAL-${series.id}`;
    const existing = await d1First<{ order_no: string; status: Order['status']; amount_cents: number; currency: 'USD'; created_at: string; paypal_order_id: string | null; approval_url: string | null }>(event,
      'SELECT order_no, status, amount_cents, currency, created_at, paypal_order_id, approval_url FROM orders WHERE order_no = ?', [entitlementOrderNo]);
    return ok({ orderNo: entitlementOrderNo, seriesId: series.id, seriesTitle: series.title, amount: Number(existing?.amount_cents ?? Math.round(series.price * 100)) / 100, currency: 'USD', status: 'paid', createdAt: existing?.created_at || now.toISOString(), paypalOrderId: existing?.paypal_order_id || undefined, approvalUrl: undefined });
  }

  const existingPending = await d1First<{ order_no: string; status: Order['status']; amount_cents: number; currency: 'USD'; created_at: string; paypal_order_id: string | null; approval_url: string | null }>(event,
    `SELECT order_no, status, amount_cents, currency, created_at, paypal_order_id, approval_url FROM orders
     WHERE user_id = ? AND series_id = ? AND status IN ('pending', 'processing') ORDER BY created_at DESC LIMIT 1`, [userId, series.id]);
  if (existingPending) {
    return ok({ orderNo: existingPending.order_no, seriesId: series.id, seriesTitle: series.title, amount: Number(existingPending.amount_cents) / 100, currency: existingPending.currency, status: existingPending.status, createdAt: existingPending.created_at, paypalOrderId: existingPending.paypal_order_id || undefined, approvalUrl: existingPending.approval_url || undefined });
  }

  // Reject before creating a new local order while checkout is intentionally offline.
  requirePayPalConfiguration(event);
  const suffix = `${now.getTime()}-${crypto.randomUUID().slice(0, 6)}`;
  const orderNo = `RN-${now.toISOString().slice(0, 10).replaceAll('-', '')}-${suffix}`;
  const amountCents = Math.round(series.price * 100);
  const origin = getRequestURL(event).origin;
  await d1Run(event, `INSERT INTO orders
    (order_no, series_id, series_slug, series_title, user_id, email, country, amount_cents, currency, status, idempotency_key, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'USD', 'pending', ?, ?, ?)`, [orderNo, series.id, series.slug, series.title, userId, userSession.email, getRequestCountry(event), amountCents, idempotencyKey, now.toISOString(), now.toISOString()]);
  try {
    const paypal = await createPayPalOrder(event, {
      orderNo, seriesTitle: series.title, amount: series.price.toFixed(2),
      returnUrl: `${origin}/api/paypal/return?orderNo=${encodeURIComponent(orderNo)}`,
      cancelUrl: `${origin}/series/${series.slug}?payment=cancelled&orderNo=${encodeURIComponent(orderNo)}`,
    });
    await d1Run(event, "UPDATE orders SET paypal_order_id = ?, approval_url = ?, status = 'processing', updated_at = ? WHERE order_no = ?", [paypal.paypalOrderId, paypal.approvalUrl, new Date().toISOString(), orderNo]);
    const order: Order = { orderNo, seriesId: series.id, seriesTitle: series.title, amount: series.price, currency: 'USD', status: 'processing', createdAt: now.toISOString(), paypalOrderId: paypal.paypalOrderId, approvalUrl: paypal.approvalUrl };
    return ok(order);
  } catch (error) {
    await d1Run(event, "UPDATE orders SET status = 'failed', note = ?, updated_at = ? WHERE order_no = ?", [error instanceof Error ? error.message : 'PayPal order creation failed', new Date().toISOString(), orderNo]);
    throw error;
  }
});
