import { seriesList } from '~/data/mock';
import { ok } from '~/server/utils/response';
import { d1Run, getRequestCountry } from '~/server/utils/cloudflare-d1';
import { createPayPalOrder } from '~/server/utils/paypal';
import { assertUserEnabled, upsertUserProfile } from '~/server/utils/user-profile';
import { getUserSession } from '~/server/utils/user-auth';
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

  const body = await readBody<{ seriesId: string }>(event);
  const series = seriesList.find((item) => item.id === body.seriesId);
  if (!series) throw createError({ statusCode: 404, statusMessage: 'Series not found' });
  if (series.price <= 0) throw createError({ statusCode: 400, statusMessage: 'Free series does not require checkout' });
  const now = new Date();
  const suffix = `${now.getTime()}`.slice(-8);
  const orderNo = `RN-${now.toISOString().slice(0, 10).replaceAll('-', '')}-${suffix}`;
  const userId = userSession.userId;
  await upsertUserProfile(event, { userId });
  await assertUserEnabled(event, userId);
  const amountCents = Math.round(series.price * 100);
  const origin = getRequestURL(event).origin;
  await d1Run(event, `INSERT INTO orders
    (order_no, series_id, series_slug, series_title, user_id, country, amount_cents, currency, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'USD', 'pending', ?, ?)`, [orderNo, series.id, series.slug, series.title, userId, getRequestCountry(event), amountCents, now.toISOString(), now.toISOString()]);
  try {
    const paypal = await createPayPalOrder(event, {
      orderNo, seriesTitle: series.title, amount: series.price.toFixed(2),
      returnUrl: `${origin}/api/paypal/return?orderNo=${encodeURIComponent(orderNo)}`,
      cancelUrl: `${origin}/series/${series.slug}?payment=cancelled&orderNo=${encodeURIComponent(orderNo)}`,
    });
    await d1Run(event, "UPDATE orders SET paypal_order_id = ?, status = 'processing', updated_at = ? WHERE order_no = ?", [paypal.paypalOrderId, new Date().toISOString(), orderNo]);
    const order: Order = { orderNo, seriesId: series.id, seriesTitle: series.title, amount: series.price, currency: 'USD', status: 'processing', createdAt: now.toISOString(), paypalOrderId: paypal.paypalOrderId, approvalUrl: paypal.approvalUrl };
    return ok(order);
  } catch (error) {
    await d1Run(event, "UPDATE orders SET status = 'failed', note = ?, updated_at = ? WHERE order_no = ?", [error instanceof Error ? error.message : 'PayPal order creation failed', new Date().toISOString(), orderNo]);
    throw error;
  }
});
