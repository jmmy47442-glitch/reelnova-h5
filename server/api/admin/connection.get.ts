import { ok } from '~/server/utils/response';
import { d1First } from '~/server/utils/cloudflare-d1';
import { getPayPalConfigurationStatus, testPayPalConnection } from '~/server/utils/paypal';

export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig(event);
  let database = false;
  let databaseError: string | null = null;
  let paypal = false;
  let paypalError: string | null = null;
  let lastWebhookAt: string | null = null;
  const paypalConfiguration = getPayPalConfigurationStatus(event);
  try {
    await d1First<{ value: number }>(event, 'SELECT 1 AS value');
    await d1First<{ value: number }>(event, `SELECT
      (SELECT COUNT(*) FROM series) + (SELECT COUNT(*) FROM episodes) +
      (SELECT COUNT(*) FROM tags) + (SELECT COUNT(*) FROM media_assets) AS value`);
    database = true;
    lastWebhookAt = (await d1First<{ value: string | null }>(event, 'SELECT MAX(received_at) AS value FROM paypal_webhook_events'))?.value || null;
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
    },
    paypal: {
      connected: paypal,
      ready: paypal && paypalConfiguration.browserClientConfigured && paypalConfiguration.clientIdsMatch && paypalConfiguration.webhookConfigured,
      error: paypalError,
      ...paypalConfiguration,
      lastWebhookAt,
    },
  });
});
