import type { H3Event } from 'h3';
import { d1First, d1Run } from '~/server/utils/cloudflare-d1';
import { upsertUserProfile } from '~/server/utils/user-profile';

interface PayPalAccessToken { access_token: string }
interface PayPalLink { rel: string; href: string }
interface PayPalOrderResponse { id: string; status: string; links?: PayPalLink[] }
interface PayPalRefundResponse { id: string; status: 'PENDING' | 'COMPLETED' | 'CANCELLED'; amount?: { currency_code: string; value: string } }
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
  amount_cents: number; currency: string; status: string; paypal_order_id: string | null;
}

const paypalRequestTimeoutMs = 10_000;

export const getPayPalConfigurationStatus = (event: H3Event) => {
  const config = useRuntimeConfig(event);
  const clientId = String(config.paypalClientId || '');
  const publicClientId = String(config.public.paypalClientId || '');
  const environment = String(config.paypalEnvironment || 'sandbox');
  return {
    credentialsConfigured: Boolean(clientId && config.paypalSecret),
    browserClientConfigured: Boolean(publicClientId),
    clientIdsMatch: Boolean(clientId && publicClientId && clientId === publicClientId),
    webhookConfigured: Boolean(config.paypalWebhookId),
    environment,
    environmentValid: environment === 'sandbox' || environment === 'production',
  };
};

const configFor = (event: H3Event) => {
  const config = useRuntimeConfig(event);
  const clientId = config.paypalClientId as string;
  const secret = config.paypalSecret as string;
  const environment = config.paypalEnvironment as string;
  if (!clientId || !secret) throw createError({
    statusCode: 503,
    statusMessage: 'PayPal checkout is not configured',
    data: { code: 'PAYPAL_NOT_CONFIGURED' },
  });
  if (environment !== 'sandbox' && environment !== 'production') throw createError({
    statusCode: 500,
    statusMessage: 'PAYPAL_ENVIRONMENT must be sandbox or production',
    data: { code: 'PAYPAL_ENVIRONMENT_INVALID' },
  });
  return { clientId, secret, baseUrl: environment === 'production' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com' };
};

export const requirePayPalConfiguration = (event: H3Event) => configFor(event);

const accessToken = async (event: H3Event) => {
  const { clientId, secret, baseUrl } = configFor(event);
  const auth = btoa(`${clientId}:${secret}`);
  const response = await $fetch<PayPalAccessToken>(`${baseUrl}/v1/oauth2/token`, {
    method: 'POST', timeout: paypalRequestTimeoutMs, headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials',
  });
  return { token: response.access_token, baseUrl };
};

export const testPayPalConnection = async (event: H3Event) => Boolean((await accessToken(event)).token);

export const createPayPalOrder = async (event: H3Event, input: { orderNo: string; seriesTitle: string; amount: string; returnUrl: string; cancelUrl: string }) => {
  const { token, baseUrl } = await accessToken(event);
  const response = await $fetch<PayPalOrderResponse>(`${baseUrl}/v2/checkout/orders`, {
    method: 'POST',
    timeout: paypalRequestTimeoutMs,
    headers: { Authorization: `Bearer ${token}`, 'PayPal-Request-Id': input.orderNo, 'Content-Type': 'application/json' },
    body: {
      intent: 'CAPTURE',
      purchase_units: [{ reference_id: input.orderNo, invoice_id: input.orderNo, description: `ReelNova: ${input.seriesTitle}`, amount: { currency_code: 'USD', value: input.amount } }],
      payment_source: { paypal: { experience_context: { brand_name: 'ReelNova', user_action: 'PAY_NOW', return_url: input.returnUrl, cancel_url: input.cancelUrl } } },
    },
  });
  const approvalUrl = response.links?.find((link) => link.rel === 'payer-action' || link.rel === 'approve')?.href;
  if (!approvalUrl) throw createError({ statusCode: 502, statusMessage: 'PayPal approval URL missing' });
  return { paypalOrderId: response.id, approvalUrl };
};

export const capturePayPalOrder = async (event: H3Event, paypalOrderId: string) => {
  const { token, baseUrl } = await accessToken(event);
  return $fetch<PayPalCaptureResponse>(`${baseUrl}/v2/checkout/orders/${encodeURIComponent(paypalOrderId)}/capture`, {
    method: 'POST', timeout: paypalRequestTimeoutMs, headers: { Authorization: `Bearer ${token}`, 'PayPal-Request-Id': `capture-${paypalOrderId}`, 'Content-Type': 'application/json' }, body: {},
  });
};

export const getPayPalOrderDetails = async (event: H3Event, paypalOrderId: string) => {
  const { token, baseUrl } = await accessToken(event);
  return $fetch<PayPalCaptureResponse>(`${baseUrl}/v2/checkout/orders/${encodeURIComponent(paypalOrderId)}`, {
    timeout: paypalRequestTimeoutMs,
    headers: { Authorization: `Bearer ${token}` },
  });
};

export const refundPayPalCapture = async (event: H3Event, input: { captureId: string; requestId: string; amount: string }) => {
  const { token, baseUrl } = await accessToken(event);
  return $fetch<PayPalRefundResponse>(`${baseUrl}/v2/payments/captures/${encodeURIComponent(input.captureId)}/refund`, {
    method: 'POST', timeout: paypalRequestTimeoutMs,
    headers: { Authorization: `Bearer ${token}`, 'PayPal-Request-Id': input.requestId, 'Content-Type': 'application/json' },
    body: { amount: { currency_code: 'USD', value: input.amount } },
  });
};

export const applyVerifiedRefund = async (event: H3Event, input: { paypalRefundId: string; paypalOrderId?: string | null; captureId?: string | null; status: string }) => {
  const order = await d1First<{ order_no: string; user_id: string; series_id: string }>(event,
    `SELECT order_no, user_id, series_id FROM orders
     WHERE (? IS NOT NULL AND paypal_order_id = ?) OR (? IS NOT NULL AND capture_id = ?) LIMIT 1`,
  [input.paypalOrderId || null, input.paypalOrderId || null, input.captureId || null, input.captureId || null]);
  if (!order) throw createError({ statusCode: 404, statusMessage: 'Refund order not found' });
  const now = new Date().toISOString();
  const completed = ['COMPLETED', 'REFUNDED', 'REVERSED'].includes(input.status);
  await d1Run(event, `UPDATE refund_requests SET paypal_refund_id = COALESCE(paypal_refund_id, ?), status = ?, error_message = NULL, updated_at = ?, completed_at = ?
    WHERE order_no = ? AND status IN ('pending', 'processing', 'failed')`, [input.paypalRefundId, completed ? 'completed' : 'processing', now, completed ? now : null, order.order_no]);
  await d1Run(event, 'UPDATE orders SET status = ?, note = ?, updated_at = ? WHERE order_no = ?', [completed ? 'refunded' : 'refunding', completed ? `PayPal refund ${input.paypalRefundId} completed` : `PayPal refund ${input.paypalRefundId} processing`, now, order.order_no]);
  if (completed) await d1Run(event, "UPDATE entitlements SET status = 'revoked', revoked_at = ? WHERE user_id = ? AND series_id = ? AND status = 'granted'", [now, order.user_id, order.series_id]);
  return { ...order, completed };
};

export const applyVerifiedCapture = async (event: H3Event, paypalOrderId: string, capture: PayPalCaptureResponse) => {
  const order = await d1First<OrderSnapshot>(event, 'SELECT * FROM orders WHERE paypal_order_id = ?', [paypalOrderId]);
  if (!order) throw createError({ statusCode: 404, statusMessage: 'Local order not found' });
  const payerEmail = capture.payer?.email_address || capture.payment_source?.paypal?.email_address || null;
  const payerCountry = capture.payer?.address?.country_code || capture.payment_source?.paypal?.address?.country_code || null;
  if (order.status === 'paid') {
    await upsertUserProfile(event, { userId: order.user_id, country: payerCountry, includeDevice: false });
    return order;
  }
  const payment = capture.purchase_units?.[0]?.payments?.captures?.[0];
  if (!payment || payment.status !== 'COMPLETED') throw createError({ statusCode: 409, statusMessage: 'PayPal capture is not completed' });
  const paidCents = Math.round(Number(payment.amount.value) * 100);
  const now = new Date().toISOString();
  if (payment.amount.currency_code !== order.currency || paidCents !== Number(order.amount_cents)) {
    await d1Run(event, "UPDATE orders SET status = 'risk_review', capture_id = ?, callback_at = ?, updated_at = ?, note = ? WHERE order_no = ?", [payment.id, now, now, `Capture mismatch: ${payment.amount.value} ${payment.amount.currency_code}`, order.order_no]);
    throw createError({ statusCode: 409, statusMessage: 'Capture amount or currency mismatch' });
  }
  const feeCents = Math.round(Number(payment.seller_receivable_breakdown?.paypal_fee?.value || 0) * 100);
  await d1Run(event, "UPDATE orders SET status = 'paid', capture_id = ?, fee_cents = ?, email = COALESCE(?, email), country = COALESCE(?, country), callback_at = ?, updated_at = ? WHERE order_no = ? AND status != 'paid'", [payment.id, feeCents, payerEmail, payerCountry, now, now, order.order_no]);
  await d1Run(event, `INSERT INTO entitlements (id, user_id, series_id, order_no, status, granted_at)
    VALUES (?, ?, ?, ?, 'granted', ?) ON CONFLICT(user_id, series_id) DO UPDATE SET order_no = excluded.order_no, status = 'granted', granted_at = excluded.granted_at, revoked_at = NULL`,
  [crypto.randomUUID(), order.user_id, order.series_id, order.order_no, now]);
  await upsertUserProfile(event, {
    userId: order.user_id,
    country: payerCountry,
    includeDevice: false,
  });
  return order;
};

export const verifyPayPalWebhook = async (event: H3Event, webhookEvent: unknown) => {
  const config = useRuntimeConfig(event);
  const webhookId = config.paypalWebhookId as string;
  if (!webhookId) throw createError({ statusCode: 503, statusMessage: 'PAYPAL_WEBHOOK_ID is not configured' });
  const { token, baseUrl } = await accessToken(event);
  const response = await $fetch<{ verification_status: 'SUCCESS' | 'FAILURE' }>(`${baseUrl}/v1/notifications/verify-webhook-signature`, {
    method: 'POST', timeout: paypalRequestTimeoutMs, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: {
      auth_algo: getHeader(event, 'paypal-auth-algo'), cert_url: getHeader(event, 'paypal-cert-url'), transmission_id: getHeader(event, 'paypal-transmission-id'),
      transmission_sig: getHeader(event, 'paypal-transmission-sig'), transmission_time: getHeader(event, 'paypal-transmission-time'), webhook_id: webhookId, webhook_event: webhookEvent,
    },
  });
  return response.verification_status;
};
