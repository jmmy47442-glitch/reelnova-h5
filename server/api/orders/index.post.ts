import { ok } from '~/server/utils/response';
import { d1First, d1Run, getRequestCountry } from '~/server/utils/cloudflare-d1';
import { createPayPalOrder, getActivePayPalEnvironment, requirePayPalConfiguration, type PayPalEnvironment } from '~/server/utils/paypal';
import { assertUserEnabled, upsertUserProfile } from '~/server/utils/user-profile';
import { getUserSession } from '~/server/utils/user-auth';
import { getPublicSeries } from '~/server/utils/managed-content';
import type { Order } from '~/types/content';

interface OrderRow {
  order_no: string;
  series_id: string;
  series_slug: string;
  series_title: string;
  user_id: string;
  amount_cents: number;
  currency: 'USD';
  status: Order['status'];
  created_at: string;
  paypal_order_id: string | null;
  approval_url: string | null;
  paypal_environment: PayPalEnvironment | null;
}

const toOrder = (row: OrderRow, entitlementStatus: Order['entitlementStatus'] = 'pending'): Order => ({
  orderNo: row.order_no,
  seriesId: row.series_id,
  seriesTitle: row.series_title,
  amount: Number(row.amount_cents) / 100,
  currency: row.currency,
  status: row.status,
  createdAt: row.created_at,
  paypalOrderId: row.paypal_order_id || undefined,
  approvalUrl: row.approval_url || undefined,
  entitlementStatus,
});

const findOpenOrder = (event: Parameters<typeof d1First>[0], userId: string, seriesId: string) =>
  d1First<OrderRow>(event, `SELECT order_no, series_id, series_slug, series_title, user_id, amount_cents, currency,
    status, created_at, paypal_order_id, approval_url, paypal_environment
    FROM orders WHERE user_id = ? AND series_id = ? AND status IN ('pending', 'processing')
    ORDER BY created_at DESC LIMIT 1`, [userId, seriesId]);

const findFailedCreationAttempt = (
  event: Parameters<typeof d1First>[0],
  userId: string,
  seriesId: string,
  idempotencyKey: string,
) => d1First<OrderRow>(event, `SELECT order_no, series_id, series_slug, series_title, user_id, amount_cents, currency,
  status, created_at, paypal_order_id, approval_url, paypal_environment
  FROM orders WHERE user_id = ? AND series_id = ? AND idempotency_key = ?
    AND status = 'failed' AND paypal_order_id IS NULL
  LIMIT 1`, [userId, seriesId, idempotencyKey]);

const initializePayPal = async (event: Parameters<typeof d1First>[0], row: OrderRow) => {
  if (row.paypal_order_id && row.approval_url) return toOrder(row);
  await requirePayPalConfiguration(event, row.paypal_environment || undefined);
  const origin = getRequestURL(event).origin;
  try {
    const paypal = await createPayPalOrder(event, {
      orderNo: row.order_no,
      seriesTitle: row.series_title,
      amount: (Number(row.amount_cents) / 100).toFixed(2),
      returnUrl: `${origin}/api/paypal/return?orderNo=${encodeURIComponent(row.order_no)}`,
      cancelUrl: `${origin}/series/${row.series_slug}?payment=cancelled&orderNo=${encodeURIComponent(row.order_no)}`,
      environment: row.paypal_environment || undefined,
    });
    const updatedAt = new Date().toISOString();
    await d1Run(event, `UPDATE orders SET paypal_order_id = ?, approval_url = ?, status = 'processing', updated_at = ?
      WHERE order_no = ? AND paypal_order_id IS NULL AND status IN ('pending', 'failed')`,
    [paypal.paypalOrderId, paypal.approvalUrl, updatedAt, row.order_no]);
    const current = await d1First<OrderRow>(event, `SELECT order_no, series_id, series_slug, series_title, user_id,
      amount_cents, currency, status, created_at, paypal_order_id, approval_url, paypal_environment FROM orders WHERE order_no = ?`, [row.order_no]);
    if (!current?.paypal_order_id || !current.approval_url) {
      throw createError({ statusCode: 409, statusMessage: 'Checkout initialization is still in progress', data: { code: 'CHECKOUT_INITIALIZING' } });
    }
    return toOrder(current);
  } catch (error) {
    // Keep the claim resumable. Releasing it here could let another request
    // create a second order while a concurrent PayPal call is still finishing.
    await d1Run(event, `UPDATE orders SET note = ?, updated_at = ?
      WHERE order_no = ? AND status = 'pending' AND paypal_order_id IS NULL`,
    [error instanceof Error ? error.message : 'PayPal order creation failed', new Date().toISOString(), row.order_no]);
    throw error;
  }
};

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
    const existing = await d1First<OrderRow>(event, `SELECT order_no, series_id, series_slug, series_title, user_id,
      amount_cents, currency, status, created_at, paypal_order_id, approval_url, paypal_environment FROM orders WHERE order_no = ?`, [entitlementOrderNo]);
    if (existing) return ok({ ...toOrder(existing, 'granted'), status: 'paid' as const, approvalUrl: undefined });
    return ok({ orderNo: entitlementOrderNo, seriesId: series.id, seriesTitle: series.title,
      amount: series.price, currency: 'USD' as const, status: 'paid' as const, createdAt: now.toISOString(), entitlementStatus: 'granted' as const });
  }

  const existingPending = await findOpenOrder(event, userId, series.id);
  if (existingPending) return ok(await initializePayPal(event, existingPending));

  const blockingOrder = await d1First<OrderRow>(event, `SELECT order_no, series_id, series_slug, series_title, user_id,
    amount_cents, currency, status, created_at, paypal_order_id, approval_url, paypal_environment FROM orders
    WHERE user_id = ? AND series_id = ? AND status IN ('paid', 'refunding', 'risk_review')
    ORDER BY created_at DESC LIMIT 1`, [userId, series.id]);
  if (blockingOrder?.status === 'paid') {
    // A paid row must already have an entitlement from the verified capture
    // transaction. Never turn a locally edited/stale status into access here.
    throw createError({
      statusCode: 409,
      statusMessage: 'This payment is awaiting entitlement reconciliation',
      data: { code: 'ORDER_ENTITLEMENT_MISSING', orderNo: blockingOrder.order_no },
    });
  }
  if (blockingOrder) throw createError({
    statusCode: 409,
    statusMessage: 'A payment for this series is already under review',
    data: { code: 'PURCHASE_ALREADY_IN_REVIEW', orderNo: blockingOrder.order_no, status: blockingOrder.status },
  });

  await requirePayPalConfiguration(event);

  // A PayPal creation failure must be retried on the same local order. Creating
  // another row with the same client key conflicts with the existing unique index.
  const failedCreationAttempt = idempotencyKey
    ? await findFailedCreationAttempt(event, userId, series.id, idempotencyKey)
    : null;
  if (failedCreationAttempt) {
    const retryAt = new Date().toISOString();
    await d1Run(event, `UPDATE OR IGNORE orders SET status = 'pending', note = NULL, updated_at = ?
      WHERE order_no = ? AND status = 'failed' AND paypal_order_id IS NULL`,
    [retryAt, failedCreationAttempt.order_no]);
    const retryOrder = await findOpenOrder(event, userId, series.id);
    if (retryOrder) return ok(await initializePayPal(event, retryOrder));
  }

  const suffix = `${now.getTime()}-${crypto.randomUUID().slice(0, 6)}`;
  const orderNo = `RN-${now.toISOString().slice(0, 10).replaceAll('-', '')}-${suffix}`;
  const priceSource = await d1First<{
    updated_at: string;
    price_cents: number;
    original_price_cents: number | null;
    version_no: number | null;
  }>(event, `SELECT s.updated_at, s.price_cents, s.original_price_cents,
    (SELECT MAX(version_no) FROM content_versions WHERE series_id = s.id) AS version_no
    FROM series s WHERE s.id = ?`, [series.id]);
  const amountCents = Number(priceSource?.price_cents ?? Math.round(series.price * 100));
  const priceVersion = priceSource?.version_no
    ? `content:${priceSource.version_no}`
    : `series:${priceSource?.updated_at || amountCents}`;
  const originalAmountCents = Number(priceSource?.original_price_cents
    ?? Math.round((series.originalPrice ?? amountCents / 100) * 100));
  const pricingSnapshot = JSON.stringify({
    seriesId: series.id, seriesSlug: series.slug, seriesTitle: series.title,
    amountCents, currency: 'USD', priceVersion, capturedAt: now.toISOString(),
  });
  const activitySnapshot = JSON.stringify({
    activityCode: null, badge: series.badge, originalAmountCents,
    discountPercent: originalAmountCents > 0
      ? Math.max(0, Math.min(100, Math.round((1 - amountCents / originalAmountCents) * 100)))
      : 0,
  });
  const businessIdempotencyKey = `series-purchase:${userId}:${series.id}`;
  const paypalEnvironment = await getActivePayPalEnvironment(event);

  // The INSERT is the concurrency boundary: entitlement and blocking-order checks
  // happen in the same database statement as the unique open-checkout claim.
  await d1Run(event, `INSERT OR IGNORE INTO orders
    (order_no, series_id, series_slug, series_title, user_id, email, country, amount_cents, currency,
     status, idempotency_key, business_idempotency_key, price_version, pricing_snapshot_json,
     activity_snapshot_json, paypal_environment, created_at, updated_at)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'USD', 'pending', ?, ?, ?, ?, ?, ?, ?, ?
    WHERE NOT EXISTS (
      SELECT 1 FROM entitlements WHERE user_id = ? AND series_id = ? AND status = 'granted'
    ) AND NOT EXISTS (
      SELECT 1 FROM manual_entitlements WHERE user_id = ? AND series_id = ? AND status = 'granted'
    ) AND NOT EXISTS (
      SELECT 1 FROM orders WHERE user_id = ? AND series_id = ?
        AND status IN ('pending', 'processing', 'paid', 'refunding', 'risk_review')
    )`, [
    orderNo, series.id, series.slug, series.title, userId, userSession.email, getRequestCountry(event), amountCents,
    idempotencyKey, businessIdempotencyKey, priceVersion, pricingSnapshot, activitySnapshot, paypalEnvironment,
    now.toISOString(), now.toISOString(), userId, series.id, userId, series.id, userId, series.id,
  ]);

  const concurrentEntitlement = await d1First<{ order_no: string }>(event, `SELECT order_no FROM entitlements
    WHERE user_id = ? AND series_id = ? AND status = 'granted' LIMIT 1`, [userId, series.id]);
  if (concurrentEntitlement) {
    const paid = await d1First<OrderRow>(event, `SELECT order_no, series_id, series_slug, series_title, user_id,
      amount_cents, currency, status, created_at, paypal_order_id, approval_url, paypal_environment FROM orders WHERE order_no = ?`, [concurrentEntitlement.order_no]);
    if (paid) return ok({ ...toOrder(paid, 'granted'), status: 'paid' as const, approvalUrl: undefined });
  }

  const claimedOrder = await findOpenOrder(event, userId, series.id);
  if (claimedOrder) return ok(await initializePayPal(event, claimedOrder));

  const repeatedRequest = idempotencyKey
    ? await d1First<OrderRow>(event, `SELECT order_no, series_id, series_slug, series_title, user_id,
      amount_cents, currency, status, created_at, paypal_order_id, approval_url, paypal_environment FROM orders
      WHERE user_id = ? AND series_id = ? AND idempotency_key = ? LIMIT 1`, [userId, series.id, idempotencyKey])
    : null;
  if (repeatedRequest) return ok(toOrder(repeatedRequest));
  throw createError({ statusCode: 409, statusMessage: 'This purchase cannot start while another payment is being resolved', data: { code: 'PURCHASE_CONFLICT' } });
});
