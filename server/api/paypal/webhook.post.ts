import { ok } from '~/server/utils/response';
import { d1First, d1Run } from '~/server/utils/cloudflare-d1';
import { applyVerifiedCapture, applyVerifiedRefund, verifyPayPalWebhook } from '~/server/utils/paypal';

interface PayPalWebhook {
  id: string;
  event_type: string;
  resource: { id?: string; status?: string; supplementary_data?: { related_ids?: { order_id?: string; capture_id?: string } } };
}

export default defineEventHandler(async (event) => {
  const body = await readBody<PayPalWebhook>(event);
  if (!body?.id || !body.event_type) throw createError({ statusCode: 400, statusMessage: 'Invalid webhook event' });
  const existing = await d1First<{ processing_status: string }>(event, 'SELECT processing_status FROM paypal_webhook_events WHERE event_id = ?', [body.id]);
  if (existing?.processing_status === 'processed') return ok({ received: true, duplicate: true });
  const verification = await verifyPayPalWebhook(event, body);
  const paypalOrderId = body.resource.supplementary_data?.related_ids?.order_id || null;
  const now = new Date().toISOString();
  await d1Run(event, `INSERT INTO paypal_webhook_events (event_id, event_type, paypal_order_id, verification_status, processing_status, received_at)
    VALUES (?, ?, ?, ?, 'ignored', ?) ON CONFLICT(event_id) DO UPDATE SET verification_status = excluded.verification_status`, [body.id, body.event_type, paypalOrderId, verification, now]);
  if (verification !== 'SUCCESS') throw createError({ statusCode: 400, statusMessage: 'PayPal webhook verification failed' });
  try {
    if (body.event_type === 'PAYMENT.CAPTURE.COMPLETED' && paypalOrderId) {
      await applyVerifiedCapture(event, paypalOrderId, { id: paypalOrderId, status: 'COMPLETED', purchase_units: [{ payments: { captures: [body.resource as any] } }] });
    }
    if (['PAYMENT.CAPTURE.REFUNDED', 'PAYMENT.CAPTURE.REVERSED'].includes(body.event_type)) {
      await applyVerifiedRefund(event, {
        paypalRefundId: body.resource.id || body.id,
        paypalOrderId,
        captureId: body.resource.supplementary_data?.related_ids?.capture_id || null,
        status: body.event_type === 'PAYMENT.CAPTURE.REVERSED' ? 'REVERSED' : body.resource.status || 'COMPLETED',
      });
    }
    await d1Run(event, "UPDATE paypal_webhook_events SET processing_status = 'processed', processed_at = ? WHERE event_id = ?", [new Date().toISOString(), body.id]);
    return ok({ received: true });
  } catch (error) {
    await d1Run(event, "UPDATE paypal_webhook_events SET processing_status = 'failed', error_message = ?, processed_at = ? WHERE event_id = ?", [error instanceof Error ? error.message : 'Webhook processing failed', new Date().toISOString(), body.id]);
    throw error;
  }
});
