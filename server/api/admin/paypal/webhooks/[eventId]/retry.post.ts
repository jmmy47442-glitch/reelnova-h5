import { ok } from '~/server/utils/response';
import { d1First, d1Run } from '~/server/utils/cloudflare-d1';
import { processVerifiedPayPalWebhook, type PayPalWebhookEvent } from '~/server/utils/paypal';
import { requireSuperAdmin } from '~/server/utils/admin-auth';
import { recordAdminAudit } from '~/server/utils/admin-audit';

interface WebhookRow {
  event_id: string;
  verification_status: string;
  processing_status: string;
  payload_json: string | null;
  retry_count: number;
}

export default defineEventHandler(async (event) => {
  const admin = requireSuperAdmin(event);
  const eventId = getRouterParam(event, 'eventId') || '';
  const row = await d1First<WebhookRow>(event, 'SELECT event_id, verification_status, processing_status, payload_json, retry_count FROM paypal_webhook_events WHERE event_id = ?', [eventId]);
  if (!row) throw createError({ statusCode: 404, statusMessage: 'Webhook event not found' });
  if (row.processing_status === 'processed') return ok({ eventId, status: 'processed' as const, duplicate: true });
  if (row.verification_status !== 'SUCCESS') throw createError({ statusCode: 409, statusMessage: 'Unverified webhook cannot be retried' });
  if (!row.payload_json) throw createError({ statusCode: 409, statusMessage: 'Legacy webhook has no replayable payload' });

  let payload: PayPalWebhookEvent;
  try { payload = JSON.parse(row.payload_json) as PayPalWebhookEvent; }
  catch { throw createError({ statusCode: 409, statusMessage: 'Stored webhook payload is invalid' }); }
  const now = new Date().toISOString();
  await d1Run(event, 'UPDATE paypal_webhook_events SET retry_count = retry_count + 1, last_retry_at = ?, error_message = NULL WHERE event_id = ?', [now, eventId]);
  let handled = false;
  try {
    handled = await processVerifiedPayPalWebhook(event, payload);
    await d1Run(event, 'UPDATE paypal_webhook_events SET processing_status = ?, processed_at = ?, error_message = NULL WHERE event_id = ?', [handled ? 'processed' : 'ignored', new Date().toISOString(), eventId]);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Webhook retry failed';
    await d1Run(event, "UPDATE paypal_webhook_events SET processing_status = 'failed', processed_at = ?, error_message = ? WHERE event_id = ?", [new Date().toISOString(), message, eventId]);
    await recordAdminAudit(event, { module: '订单与退款', action: 'PayPal Webhook 重试失败', target: eventId, detail: `${payload.event_type}; ${message}`, risk: '高风险' });
    throw error;
  }
  await recordAdminAudit(event, { module: '订单与退款', action: '重试 PayPal Webhook', target: eventId, detail: `${payload.event_type}; result=${handled ? 'processed' : 'ignored'}; attempt=${Number(row.retry_count) + 1}`, risk: '高风险' });
  return ok({ eventId, status: handled ? 'processed' as const : 'ignored' as const, retryCount: Number(row.retry_count) + 1 });
});
