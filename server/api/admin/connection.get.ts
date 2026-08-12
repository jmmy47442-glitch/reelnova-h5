import { ok } from '~/server/utils/response';
import { d1All, d1First } from '~/server/utils/cloudflare-d1';
import { getPayPalConfigurationStatus, testPayPalConnection } from '~/server/utils/paypal';
import { getCloudflareDomainAutomationStatus } from '~/server/utils/cloudflare-domains';

export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig(event);
  let database = false;
  let databaseError: string | null = null;
  let paypal = false;
  let paypalError: string | null = null;
  let lastWebhookAt: string | null = null;
  let failedWebhooks: Array<{ eventId: string; eventType: string; errorMessage: string | null; receivedAt: string; retryCount: number; replayable: boolean }> = [];
  const paypalConfiguration = await getPayPalConfigurationStatus(event);
  const domainAutomation = await getCloudflareDomainAutomationStatus(event);
  try {
    await d1First<{ value: number }>(event, 'SELECT 1 AS value');
    await d1First<{ value: number }>(event, `SELECT
      (SELECT COUNT(*) FROM series) + (SELECT COUNT(*) FROM episodes) +
      (SELECT COUNT(*) FROM tags) + (SELECT COUNT(*) FROM media_assets) AS value`);
    const paypalEnvironmentColumn = await d1First<{ value: number }>(event,
      "SELECT COUNT(*) AS value FROM pragma_table_info('orders') WHERE name = 'paypal_environment'");
    if (!Number(paypalEnvironmentColumn?.value || 0)) throw new Error('Migration 0016_paypal_environment.sql is not applied');
    database = true;
    lastWebhookAt = (await d1First<{ value: string | null }>(event, 'SELECT MAX(received_at) AS value FROM paypal_webhook_events'))?.value || null;
    const failedRows = await d1All<{ event_id: string; event_type: string; error_message: string | null; received_at: string; retry_count: number; payload_json: string | null }>(event,
      "SELECT event_id, event_type, error_message, received_at, retry_count, payload_json FROM paypal_webhook_events WHERE processing_status = 'failed' ORDER BY received_at DESC LIMIT 10");
    failedWebhooks = failedRows.map((row) => ({ eventId: row.event_id, eventType: row.event_type, errorMessage: row.error_message, receivedAt: row.received_at, retryCount: Number(row.retry_count), replayable: Boolean(row.payload_json) }));
  } catch (error) { databaseError = error instanceof Error ? error.message : 'D1 connection or content migration check failed'; }
  if (paypalConfiguration.credentialsConfigured && paypalConfiguration.environmentValid) {
    try { paypal = await testPayPalConnection(event); }
    catch (error) { paypalError = error instanceof Error ? error.message : 'PayPal connection failed'; }
  }
  return ok({
    checkedAt: new Date().toISOString(),
    cloudflare: {
      database, databaseError,
      mode: (event.context.cloudflare as { env?: { DB?: unknown } } | undefined)?.env?.DB ? 'D1 binding' : 'Cloudflare REST API',
      accountConfigured: Boolean(config.cloudflareAccountId), databaseConfigured: Boolean(config.cloudflareD1DatabaseId), apiTokenConfigured: Boolean(config.cloudflareApiToken),
      mediaConfigured: Boolean(config.cloudflareMediaWorkerUrl && config.cloudflareMediaWorkerSecret
        && config.cloudflareStreamCustomerCode && config.cloudflareStreamWebhookSecret && config.cloudflareMediaSigningSecret),
      mediaWorkerConfigured: Boolean(config.cloudflareMediaWorkerUrl && config.cloudflareMediaWorkerSecret),
      streamConfigured: Boolean(config.cloudflareStreamCustomerCode && config.cloudflareStreamWebhookSecret),
      mediaSigningConfigured: Boolean(config.cloudflareMediaSigningSecret),
      customHostnamesConfigured: domainAutomation.automationConfigured,
    },
    paypal: {
      connected: paypal,
      ready: paypal && paypalConfiguration.browserClientConfigured && paypalConfiguration.clientIdsMatch && paypalConfiguration.webhookConfigured,
      error: paypalError,
      ...paypalConfiguration,
      lastWebhookAt,
      failedWebhooks,
    },
  });
});
