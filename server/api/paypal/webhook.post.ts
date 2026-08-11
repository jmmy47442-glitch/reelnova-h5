import { ok } from '~/server/utils/response';
import { d1First, d1Run } from '~/server/utils/cloudflare-d1';
import { processVerifiedPayPalWebhook, verifyPayPalWebhook, type PayPalWebhookEvent } from '~/server/utils/paypal';

const replayablePayload = (body: PayPalWebhookEvent): PayPalWebhookEvent => ({
  id: body.id,
  event_type: body.event_type,
  resource: {
    id: body.resource?.id,
    status: body.resource?.status,
    amount: body.resource?.amount,
    seller_receivable_breakdown: body.resource?.seller_receivable_breakdown,
    supplementary_data: body.resource?.supplementary_data,
  },
});

export default defineEventHandler(async (event) => {
  const body = await readBody<PayPalWebhookEvent>(event);
  if (!body?.id || !body.event_type || !body.resource) throw createError({ statusCode: 400, statusMessage: 'Invalid webhook event' });
  const existing = await d1First<{ processing_status: string }>(event, 'SELECT processing_status FROM paypal_webhook_events WHERE event_id = ?', [body.id]);
  if (existing?.processing_status === 'processed') return ok({ received: true, duplicate: true });

  const verification = await verifyPayPalWebhook(event, body);
  const paypalOrderId = body.resource.supplementary_data?.related_ids?.order_id || null;
  const now = new Date().toISOString();
  await d1Run(event, `INSERT INTO paypal_webhook_events
    (event_id, event_type, paypal_order_id, verification_status, processing_status, payload_json, received_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(event_id) DO UPDATE SET event_type = excluded.event_type, paypal_order_id = excluded.paypal_order_id,
      verification_status = excluded.verification_status, processing_status = excluded.processing_status,
      payload_json = excluded.payload_json, error_message = NULL`, [
    body.id, body.event_type, paypalOrderId, verification, verification === 'SUCCESS' ? 'ignored' : 'failed',
    JSON.stringify(replayablePayload(body)), now,
  ]);
  if (verification !== 'SUCCESS') throw createError({ statusCode: 400, statusMessage: 'PayPal webhook verification failed' });

  try {
    const handled = await processVerifiedPayPalWebhook(event, body);
    await d1Run(event, 'UPDATE paypal_webhook_events SET processing_status = ?, processed_at = ?, error_message = NULL WHERE event_id = ?', [
      handled ? 'processed' : 'ignored', new Date().toISOString(), body.id,
    ]);
    return ok({ received: true, handled });
  } catch (error) {
    await d1Run(event, "UPDATE paypal_webhook_events SET processing_status = 'failed', error_message = ?, processed_at = ? WHERE event_id = ?", [
      error instanceof Error ? error.message : 'Webhook processing failed', new Date().toISOString(), body.id,
    ]);
    throw error;
  }
});
