import type { H3Event } from 'h3';
import { ofetch, type FetchOptions } from 'ofetch';
import { d1First, d1Run } from '~/server/utils/cloudflare-d1';
import { upsertUserProfile } from '~/server/utils/user-profile';
import { getSystemConfig, saveSystemConfig } from '~/server/utils/system-config';

interface PayPalAccessToken { access_token: string }
interface PayPalLink { rel: string; href: string }
interface PayPalOrderResponse { id: string; status: string; links?: PayPalLink[] }
interface PayPalRefundResponse { id: string; status: string; amount?: { currency_code: string; value: string } }
interface PayPalCaptureResponse {
  id: string;
  status: string;
  payer?: { email_address?: string; address?: { country_code?: string } };
  payment_source?: { paypal?: { email_address?: string; address?: { country_code?: string } } };
  purchase_units: Array<{ payments?: { captures?: Array<{
    id: string; status: string; amount: { currency_code: string; value: string };
    seller_receivable_breakdown?: { paypal_fee?: { value: string } };
  }> } }>;
}

interface OrderSnapshot {
  order_no: string; series_id: string; series_slug: string; series_title: string; user_id: string;
  amount_cents: number; currency: string; status: string; paypal_order_id: string | null; capture_id: string | null;
  paypal_environment: PayPalEnvironment | null;
}

interface RefundRequestRow {
  id: string; order_no: string; paypal_refund_id: string | null; status: string;
  entitlement_revoke_status: string;
}

export interface PayPalWebhookResource {
  id?: string;
  status?: string;
  amount?: { currency_code?: string; value?: string };
  seller_receivable_breakdown?: { paypal_fee?: { value?: string } };
  supplementary_data?: { related_ids?: { order_id?: string; capture_id?: string; refund_id?: string } };
}

export interface PayPalWebhookEvent {
  id: string;
  event_type: string;
  resource: PayPalWebhookResource;
}

const paypalRequestTimeoutMs = 10_000;

const paypalRequest = async <T>(
  url: string,
  options: FetchOptions<'json'>,
  operation: string,
): Promise<T> => {
  try {
    return await ofetch<T>(url, options);
  } catch (error: unknown) {
    const providerStatus = (error as { statusCode?: number; response?: { status?: number } }).statusCode
      || (error as { response?: { status?: number } }).response?.status;
    if (providerStatus) {
      throw createError({
        statusCode: 502,
        statusMessage: providerStatus === 401
          ? 'PayPal rejected the configured credentials'
          : `PayPal rejected the ${operation} request`,
        data: { code: providerStatus === 401 ? 'PAYPAL_CREDENTIALS_REJECTED' : 'PAYPAL_PROVIDER_ERROR' },
      });
    }
    throw createError({
      statusCode: 503,
      statusMessage: 'The server cannot connect to PayPal',
      data: { code: 'PAYPAL_CONNECTION_FAILED' },
    });
  }
};

export type PayPalEnvironment = 'sandbox' | 'production';

const isPayPalEnvironment = (value: unknown): value is PayPalEnvironment => value === 'sandbox' || value === 'production';

export const getActivePayPalEnvironment = async (event: H3Event): Promise<PayPalEnvironment> => {
  const config = useRuntimeConfig(event);
  const fallback = isPayPalEnvironment(config.paypalEnvironment) ? config.paypalEnvironment : 'sandbox';
  const saved = await getSystemConfig<{ environment?: string }>(event, 'paypal-runtime', { environment: fallback });
  return isPayPalEnvironment(saved.environment) ? saved.environment : fallback;
};

export const setActivePayPalEnvironment = async (event: H3Event, environment: PayPalEnvironment) => {
  await saveSystemConfig(event, 'paypal-runtime', { environment, updatedAt: new Date().toISOString() });
};

const credentialsForEnvironment = (event: H3Event, environment: PayPalEnvironment) => {
  const config = useRuntimeConfig(event);
  const legacyEnvironment: PayPalEnvironment = isPayPalEnvironment(config.paypalEnvironment) ? config.paypalEnvironment : 'sandbox';
  const specific = environment === 'production'
    ? {
        clientId: String(config.paypalProductionClientId || ''),
        secret: String(config.paypalProductionSecret || ''),
        webhookId: String(config.paypalProductionWebhookId || ''),
        browserClientId: String(config.paypalProductionBrowserClientId || ''),
      }
    : {
        clientId: String(config.paypalSandboxClientId || ''),
        secret: String(config.paypalSandboxSecret || ''),
        webhookId: String(config.paypalSandboxWebhookId || ''),
        browserClientId: String(config.paypalSandboxBrowserClientId || ''),
      };
  if (environment !== legacyEnvironment) return specific;
  return {
    clientId: specific.clientId || String(config.paypalClientId || ''),
    secret: specific.secret || String(config.paypalSecret || ''),
    webhookId: specific.webhookId || String(config.paypalWebhookId || ''),
    browserClientId: specific.browserClientId || String(config.public.paypalClientId || ''),
  };
};

const environmentStatus = (event: H3Event, environment: PayPalEnvironment) => {
  const values = credentialsForEnvironment(event, environment);
  return {
    credentialsConfigured: Boolean(values.clientId && values.secret),
    browserClientConfigured: Boolean(values.browserClientId),
    clientIdsMatch: Boolean(values.clientId && values.browserClientId && values.clientId === values.browserClientId),
    webhookConfigured: Boolean(values.webhookId),
  };
};

export const getPayPalConfigurationStatus = async (event: H3Event) => {
  const environment = await getActivePayPalEnvironment(event);
  const current = environmentStatus(event, environment);
  return {
    ...current,
    environment,
    environmentValid: true,
    environments: {
      sandbox: environmentStatus(event, 'sandbox'),
      production: environmentStatus(event, 'production'),
    },
  };
};

const configFor = async (event: H3Event, requestedEnvironment?: PayPalEnvironment) => {
  const environment = requestedEnvironment || await getActivePayPalEnvironment(event);
  const { clientId, secret, webhookId, browserClientId } = credentialsForEnvironment(event, environment);
  if (!clientId || !secret) throw createError({
    statusCode: 503,
    statusMessage: `PayPal ${environment} checkout is not configured`,
    data: { code: 'PAYPAL_NOT_CONFIGURED' },
  });
  return {
    clientId, secret, webhookId, browserClientId, environment,
    baseUrl: environment === 'production' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com',
  };
};

export const requirePayPalConfiguration = (event: H3Event, environment?: PayPalEnvironment) => configFor(event, environment);

const accessToken = async (event: H3Event, environment?: PayPalEnvironment): Promise<{ token: string; baseUrl: string }> => {
  const { clientId, secret, baseUrl } = await configFor(event, environment);
  const auth = btoa(`${clientId}:${secret}`);
  const response = await paypalRequest<PayPalAccessToken>(`${baseUrl}/v1/oauth2/token`, {
    method: 'POST', timeout: paypalRequestTimeoutMs, headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials',
  }, 'authentication');
  return { token: response.access_token, baseUrl };
};

export const testPayPalConnection = async (event: H3Event, environment?: PayPalEnvironment): Promise<boolean> => Boolean((await accessToken(event, environment)).token);

export const createPayPalOrder = async (event: H3Event, input: { orderNo: string; seriesTitle: string; amount: string; returnUrl: string; cancelUrl: string; environment?: PayPalEnvironment }) => {
  const { token, baseUrl } = await accessToken(event, input.environment);
  const response = await paypalRequest<PayPalOrderResponse>(`${baseUrl}/v2/checkout/orders`, {
    method: 'POST',
    timeout: paypalRequestTimeoutMs,
    headers: { Authorization: `Bearer ${token}`, 'PayPal-Request-Id': input.orderNo, 'Content-Type': 'application/json' },
    body: {
      intent: 'CAPTURE',
      purchase_units: [{ reference_id: input.orderNo, invoice_id: input.orderNo, description: `ReelNova: ${input.seriesTitle}`, amount: { currency_code: 'USD', value: input.amount } }],
      payment_source: { paypal: { experience_context: { brand_name: 'ReelNova', user_action: 'PAY_NOW', return_url: input.returnUrl, cancel_url: input.cancelUrl } } },
    },
  }, 'checkout');
  const approvalUrl = response.links?.find((link) => link.rel === 'payer-action' || link.rel === 'approve')?.href;
  if (!approvalUrl) throw createError({ statusCode: 502, statusMessage: 'PayPal approval URL missing' });
  return { paypalOrderId: response.id, approvalUrl };
};

export const capturePayPalOrder = async (event: H3Event, paypalOrderId: string, environment?: PayPalEnvironment) => {
  const { token, baseUrl } = await accessToken(event, environment);
  return $fetch<PayPalCaptureResponse>(`${baseUrl}/v2/checkout/orders/${encodeURIComponent(paypalOrderId)}/capture`, {
    method: 'POST', timeout: paypalRequestTimeoutMs, headers: { Authorization: `Bearer ${token}`, 'PayPal-Request-Id': `capture-${paypalOrderId}`, 'Content-Type': 'application/json' }, body: {},
  });
};

export const getPayPalOrderDetails = async (event: H3Event, paypalOrderId: string, environment?: PayPalEnvironment) => {
  const { token, baseUrl } = await accessToken(event, environment);
  return $fetch<PayPalCaptureResponse>(`${baseUrl}/v2/checkout/orders/${encodeURIComponent(paypalOrderId)}`, {
    timeout: paypalRequestTimeoutMs,
    headers: { Authorization: `Bearer ${token}` },
  });
};

export const refundPayPalCapture = async (event: H3Event, input: { captureId: string; requestId: string; amount: string; currency: string; environment?: PayPalEnvironment }) => {
  const { token, baseUrl } = await accessToken(event, input.environment);
  return $fetch<PayPalRefundResponse>(`${baseUrl}/v2/payments/captures/${encodeURIComponent(input.captureId)}/refund`, {
    method: 'POST', timeout: paypalRequestTimeoutMs,
    headers: { Authorization: `Bearer ${token}`, 'PayPal-Request-Id': input.requestId, 'Content-Type': 'application/json' },
    body: { amount: { currency_code: input.currency, value: input.amount } },
  });
};

export const getPayPalRefundDetails = async (event: H3Event, paypalRefundId: string, environment?: PayPalEnvironment) => {
  const { token, baseUrl } = await accessToken(event, environment);
  return $fetch<PayPalRefundResponse>(`${baseUrl}/v2/payments/refunds/${encodeURIComponent(paypalRefundId)}`, {
    timeout: paypalRequestTimeoutMs,
    headers: { Authorization: `Bearer ${token}` },
  });
};

const localRefundStatus = (providerStatus: string) => {
  const status = providerStatus.toUpperCase();
  if (['COMPLETED', 'REFUNDED', 'REVERSED'].includes(status)) return 'completed' as const;
  if (status === 'CANCELLED') return 'cancelled' as const;
  if (['FAILED', 'DENIED'].includes(status)) return 'failed' as const;
  return 'processing' as const;
};

export const recordRefundEvent = async (event: H3Event, input: {
  id?: string;
  refundRequestId: string;
  orderNo: string;
  eventType: string;
  source: 'admin' | 'paypal_api' | 'paypal_webhook' | 'system';
  actor: string;
  fromStatus?: string | null;
  toStatus: string;
  paypalEventId?: string | null;
  paypalRefundId?: string | null;
  detail: string;
}) => {
  await d1Run(event, `INSERT OR IGNORE INTO refund_events
    (id, refund_request_id, order_no, event_type, source, actor, from_status, to_status, paypal_event_id, paypal_refund_id, detail, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
    input.id || `refund_event_${crypto.randomUUID()}`, input.refundRequestId, input.orderNo,
    input.eventType, input.source, input.actor, input.fromStatus || null, input.toStatus,
    input.paypalEventId || null, input.paypalRefundId || null, input.detail, new Date().toISOString(),
  ]);
};

export const applyVerifiedRefund = async (event: H3Event, input: {
  paypalRefundId?: string | null;
  paypalOrderId?: string | null;
  captureId?: string | null;
  status: string;
  source?: 'admin' | 'paypal_api' | 'paypal_webhook' | 'system';
  actor?: string;
  paypalEventId?: string | null;
  detail?: string;
}) => {
  let request = input.paypalRefundId
    ? await d1First<RefundRequestRow>(event, 'SELECT id, order_no, paypal_refund_id, status, entitlement_revoke_status FROM refund_requests WHERE paypal_refund_id = ? LIMIT 1', [input.paypalRefundId])
    : null;
  let order = request
    ? await d1First<OrderSnapshot>(event, 'SELECT * FROM orders WHERE order_no = ?', [request.order_no])
    : null;
  if (!order && (input.paypalOrderId || input.captureId)) {
    order = await d1First<OrderSnapshot>(event, `SELECT * FROM orders
      WHERE (? IS NOT NULL AND paypal_order_id = ?) OR (? IS NOT NULL AND capture_id = ?) LIMIT 1`, [
      input.paypalOrderId || null, input.paypalOrderId || null, input.captureId || null, input.captureId || null,
    ]);
  }
  if (!order) throw createError({ statusCode: 404, statusMessage: 'Refund order not found' });

  if (!request) {
    request = await d1First<RefundRequestRow>(event, `SELECT id, order_no, paypal_refund_id, status, entitlement_revoke_status
      FROM refund_requests WHERE order_no = ? ORDER BY created_at DESC LIMIT 1`, [order.order_no]);
  }
  const now = new Date().toISOString();
  if (!request) {
    const captureId = order.capture_id || input.captureId;
    if (!captureId) throw createError({ statusCode: 409, statusMessage: 'Refund order has no Capture ID' });
    const id = `refund_${input.paypalRefundId || order.order_no}`;
    await d1Run(event, `INSERT INTO refund_requests
      (id, order_no, capture_id, paypal_refund_id, amount_cents, currency, status, request_source, provider_status,
       customer_service_result, entitlement_revoke_status, reason, requested_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', 'webhook', NULL, 'approved', 'pending', ?, ?, ?, ?)`, [
      id, order.order_no, captureId, input.paypalRefundId || null,
      order.amount_cents, order.currency, 'PayPal refund detected by verified webhook', input.actor || 'PayPal', now, now,
    ]);
    request = { id, order_no: order.order_no, paypal_refund_id: input.paypalRefundId || null, status: 'pending', entitlement_revoke_status: 'pending' };
  }

  const nextStatus = request.status === 'completed' ? 'completed' : localRefundStatus(input.status);
  const paypalRefundId = request.paypal_refund_id || input.paypalRefundId || null;
  let entitlementRevokeStatus = request.entitlement_revoke_status;
  if (nextStatus === 'completed') {
    const entitlement = await d1First<{ status: string }>(event, 'SELECT status FROM entitlements WHERE order_no = ? LIMIT 1', [order.order_no]);
    if (entitlement?.status === 'granted') {
      await d1Run(event, "UPDATE entitlements SET status = 'revoked', revoked_at = ? WHERE order_no = ? AND status = 'granted'", [now, order.order_no]);
      entitlementRevokeStatus = 'revoked';
    } else {
      entitlementRevokeStatus = entitlement?.status === 'revoked' ? 'revoked' : 'not_applicable';
    }
  }

  await d1Run(event, `UPDATE refund_requests SET paypal_refund_id = COALESCE(paypal_refund_id, ?), status = ?, provider_status = ?,
    entitlement_revoke_status = ?, error_message = NULL, resolved_by = CASE WHEN ? IN ('completed', 'failed', 'cancelled') THEN ? ELSE resolved_by END,
    resolution_note = COALESCE(?, resolution_note), updated_at = ?, completed_at = CASE WHEN ? = 'completed' THEN COALESCE(completed_at, ?) ELSE completed_at END
    WHERE id = ?`, [
    input.paypalRefundId || null, nextStatus, input.status.toUpperCase(), entitlementRevokeStatus,
    nextStatus, input.actor || 'PayPal', input.detail || null, now, nextStatus, now, request.id,
  ]);

  if (nextStatus === 'completed') {
    await d1Run(event, "UPDATE orders SET status = 'refunded', note = ?, updated_at = ? WHERE order_no = ?", [
      `Refund ${paypalRefundId || request.id} confirmed; entitlement ${entitlementRevokeStatus}`, now, order.order_no,
    ]);
  } else if (nextStatus === 'processing') {
    await d1Run(event, "UPDATE orders SET status = 'refunding', note = ?, updated_at = ? WHERE order_no = ? AND status != 'refunded'", [
      `Refund ${paypalRefundId || request.id} is ${input.status.toUpperCase()}`, now, order.order_no,
    ]);
  } else {
    await d1Run(event, "UPDATE orders SET status = 'paid', note = ?, updated_at = ? WHERE order_no = ? AND status = 'refunding'", [
      `Refund ${paypalRefundId || request.id} ${nextStatus}: ${input.status.toUpperCase()}`, now, order.order_no,
    ]);
  }

  await recordRefundEvent(event, {
    refundRequestId: request.id,
    orderNo: order.order_no,
    eventType: nextStatus === 'completed' ? 'refund_confirmed' : nextStatus === 'processing' ? 'provider_processing' : 'provider_failed',
    source: input.source || 'system',
    actor: input.actor || 'PayPal',
    fromStatus: request.status,
    toStatus: nextStatus,
    paypalEventId: input.paypalEventId,
    paypalRefundId,
    detail: input.detail || `Provider status: ${input.status.toUpperCase()}; entitlement: ${entitlementRevokeStatus}`,
  });
  return { ...order, refundRequestId: request.id, paypalRefundId, status: nextStatus, completed: nextStatus === 'completed', entitlementRevokeStatus };
};

export const applyVerifiedCapture = async (event: H3Event, paypalOrderId: string, capture: PayPalCaptureResponse) => {
  const order = await d1First<OrderSnapshot>(event, 'SELECT * FROM orders WHERE paypal_order_id = ?', [paypalOrderId]);
  if (!order) throw createError({ statusCode: 404, statusMessage: 'Local order not found' });
  const payerEmail = capture.payer?.email_address || capture.payment_source?.paypal?.email_address || null;
  const payerCountry = capture.payer?.address?.country_code || capture.payment_source?.paypal?.address?.country_code || null;
  if (['refunding', 'refunded'].includes(order.status)) return order;
  if (order.status === 'paid') {
    const now = new Date().toISOString();
    await d1Run(event, `INSERT INTO entitlements (id, user_id, series_id, order_no, status, granted_at)
      VALUES (?, ?, ?, ?, 'granted', ?) ON CONFLICT(user_id, series_id) DO NOTHING`,
    [crypto.randomUUID(), order.user_id, order.series_id, order.order_no, now]);
    await upsertUserProfile(event, { userId: order.user_id, country: payerCountry, includeDevice: false });
    return order;
  }
  if (!['pending', 'processing'].includes(order.status)) throw createError({
    statusCode: 409,
    statusMessage: 'Local order is no longer payable',
    data: { code: 'ORDER_NOT_PAYABLE', orderNo: order.order_no, status: order.status },
  });
  const payment = capture.purchase_units?.[0]?.payments?.captures?.[0];
  if (!payment || payment.status !== 'COMPLETED') throw createError({ statusCode: 409, statusMessage: 'PayPal capture is not completed' });
  const paidCents = Math.round(Number(payment.amount.value) * 100);
  const now = new Date().toISOString();
  if (payment.amount.currency_code !== order.currency || paidCents !== Number(order.amount_cents)) {
    await d1Run(event, "UPDATE orders SET status = 'risk_review', capture_id = ?, callback_at = ?, updated_at = ?, note = ? WHERE order_no = ?", [payment.id, now, now, `Capture mismatch: ${payment.amount.value} ${payment.amount.currency_code}`, order.order_no]);
    throw createError({ statusCode: 409, statusMessage: 'Capture amount or currency mismatch' });
  }
  const feeCents = Math.round(Number(payment.seller_receivable_breakdown?.paypal_fee?.value || 0) * 100);
  // Grant first so a concurrent checkout cannot slip into the gap between the
  // open order becoming paid and its entitlement being visible.
  await d1Run(event, `INSERT INTO entitlements (id, user_id, series_id, order_no, status, granted_at)
    VALUES (?, ?, ?, ?, 'granted', ?) ON CONFLICT(user_id, series_id) DO UPDATE SET order_no = excluded.order_no, status = 'granted', granted_at = excluded.granted_at, revoked_at = NULL`,
  [crypto.randomUUID(), order.user_id, order.series_id, order.order_no, now]);
  await d1Run(event, "UPDATE orders SET status = 'paid', capture_id = ?, fee_cents = ?, email = COALESCE(?, email), country = COALESCE(?, country), callback_at = ?, updated_at = ? WHERE order_no = ? AND status != 'paid'", [payment.id, feeCents, payerEmail, payerCountry, now, now, order.order_no]);
  await upsertUserProfile(event, {
    userId: order.user_id,
    country: payerCountry,
    includeDevice: false,
  });
  return order;
};

export const processVerifiedPayPalWebhook = async (event: H3Event, webhook: PayPalWebhookEvent) => {
  const relatedIds = webhook.resource.supplementary_data?.related_ids;
  const paypalOrderId = relatedIds?.order_id || null;
  if (webhook.event_type === 'PAYMENT.CAPTURE.COMPLETED') {
    if (!paypalOrderId) throw createError({ statusCode: 422, statusMessage: 'Capture webhook has no PayPal Order ID' });
    await applyVerifiedCapture(event, paypalOrderId, {
      id: paypalOrderId,
      status: 'COMPLETED',
      purchase_units: [{ payments: { captures: [webhook.resource as any] } }],
    });
    return true;
  }

  if (['PAYMENT.CAPTURE.REFUNDED', 'PAYMENT.CAPTURE.REVERSED'].includes(webhook.event_type)) {
    await applyVerifiedRefund(event, {
      paypalRefundId: relatedIds?.refund_id || null,
      paypalOrderId,
      captureId: webhook.resource.id || relatedIds?.capture_id || null,
      status: webhook.event_type === 'PAYMENT.CAPTURE.REVERSED' ? 'REVERSED' : 'COMPLETED',
      source: 'paypal_webhook',
      actor: 'PayPal Webhook',
      paypalEventId: webhook.id,
      detail: `Verified ${webhook.event_type}`,
    });
    return true;
  }

  if (webhook.event_type.startsWith('PAYMENT.REFUND.')) {
    const eventStatus = webhook.event_type.slice('PAYMENT.REFUND.'.length);
    await applyVerifiedRefund(event, {
      paypalRefundId: webhook.resource.id || null,
      paypalOrderId,
      captureId: relatedIds?.capture_id || null,
      status: webhook.resource.status || eventStatus,
      source: 'paypal_webhook',
      actor: 'PayPal Webhook',
      paypalEventId: webhook.id,
      detail: `Verified ${webhook.event_type}`,
    });
    return true;
  }
  return false;
};

export const resolvePayPalWebhookEnvironment = async (event: H3Event, webhook: PayPalWebhookEvent) => {
  const related = webhook.resource.supplementary_data?.related_ids;
  const paypalOrderId = related?.order_id || null;
  const captureId = related?.capture_id || (webhook.event_type.startsWith('PAYMENT.CAPTURE.') ? webhook.resource.id || null : null);
  let order = await d1First<{ paypal_environment: PayPalEnvironment | null }>(event, `SELECT paypal_environment FROM orders
    WHERE (? IS NOT NULL AND paypal_order_id = ?) OR (? IS NOT NULL AND capture_id = ?) LIMIT 1`, [
    paypalOrderId, paypalOrderId, captureId, captureId,
  ]);
  if (!order && webhook.resource.id) {
    order = await d1First<{ paypal_environment: PayPalEnvironment | null }>(event, `SELECT o.paypal_environment
      FROM refund_requests rr JOIN orders o ON o.order_no = rr.order_no
      WHERE rr.paypal_refund_id = ? LIMIT 1`, [webhook.resource.id]);
  }
  return isPayPalEnvironment(order?.paypal_environment) ? order.paypal_environment : getActivePayPalEnvironment(event);
};

export const verifyPayPalWebhook = async (event: H3Event, webhookEvent: unknown, requestedEnvironment?: PayPalEnvironment) => {
  const environment = requestedEnvironment || await getActivePayPalEnvironment(event);
  const { webhookId } = await configFor(event, environment);
  if (!webhookId) throw createError({ statusCode: 503, statusMessage: 'PAYPAL_WEBHOOK_ID is not configured' });
  const { token, baseUrl } = await accessToken(event, environment);
  const response = await $fetch<{ verification_status: 'SUCCESS' | 'FAILURE' }>(`${baseUrl}/v1/notifications/verify-webhook-signature`, {
    method: 'POST', timeout: paypalRequestTimeoutMs, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: {
      auth_algo: getHeader(event, 'paypal-auth-algo'), cert_url: getHeader(event, 'paypal-cert-url'), transmission_id: getHeader(event, 'paypal-transmission-id'),
      transmission_sig: getHeader(event, 'paypal-transmission-sig'), transmission_time: getHeader(event, 'paypal-transmission-time'), webhook_id: webhookId, webhook_event: webhookEvent,
    },
  });
  return response.verification_status;
};
