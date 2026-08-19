import { ok } from '~/server/utils/response';
import { d1All, d1First } from '~/server/utils/cloudflare-d1';
import {
  formatDatabaseSchemaError,
  inspectDatabaseSchema,
  type DatabaseSchemaHealth,
} from '~/server/utils/database-health';
import { getPayPalConfigurationStatus, testPayPalConnection } from '~/server/utils/paypal';
import { getCloudflareDomainAutomationStatus } from '~/server/utils/cloudflare-domains';

export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig(event);
  const missingCloudflareFields = {
    streamApi: [
      !config.cloudflareAccountId ? 'CLOUDFLARE_ACCOUNT_ID' : '',
      !config.cloudflareApiToken ? 'CLOUDFLARE_API_TOKEN' : '',
    ].filter(Boolean),
    mediaWorker: [
      !config.cloudflareMediaWorkerUrl ? 'CLOUDFLARE_MEDIA_WORKER_URL' : '',
      !config.cloudflareMediaWorkerSecret ? 'CLOUDFLARE_MEDIA_WORKER_SECRET' : '',
    ].filter(Boolean),
    playback: [
      !config.cloudflareMediaSigningSecret ? 'CLOUDFLARE_MEDIA_SIGNING_SECRET' : '',
    ].filter(Boolean),
    streamWebhook: [
      !config.cloudflareStreamWebhookSecret ? 'CLOUDFLARE_STREAM_WEBHOOK_SECRET' : '',
    ].filter(Boolean),
  };
  let database = false;
  let databaseError: string | null = null;
  let databaseSchema: DatabaseSchemaHealth | null = null;
  let paypal = false;
  let paypalError: string | null = null;
  let streamApi = false;
  let streamApiError: string | null = null;
  let lastWebhookAt: string | null = null;
  let failedWebhooks: Array<{ eventId: string; eventType: string; errorMessage: string | null; receivedAt: string; retryCount: number; replayable: boolean }> = [];
  const paypalConfiguration = await getPayPalConfigurationStatus(event);
  const domainAutomation = await getCloudflareDomainAutomationStatus(event);
  try {
    databaseSchema = await inspectDatabaseSchema(event);
    if (!databaseSchema.healthy) throw new Error(formatDatabaseSchemaError(databaseSchema));
    database = true;
    lastWebhookAt = (await d1First<{ value: string | null }>(event,
      'SELECT MAX(received_at) AS value FROM paypal_webhook_events'))?.value || null;
    const failedRows = await d1All<{ event_id: string; event_type: string; error_message: string | null; received_at: string; retry_count: number; payload_json: string | null }>(event,
      "SELECT event_id, event_type, error_message, received_at, retry_count, payload_json FROM paypal_webhook_events WHERE processing_status = 'failed' ORDER BY received_at DESC LIMIT 10");
    failedWebhooks = failedRows.map((row) => ({ eventId: row.event_id, eventType: row.event_type, errorMessage: row.error_message, receivedAt: row.received_at, retryCount: Number(row.retry_count), replayable: Boolean(row.payload_json) }));
  } catch (error) { databaseError = error instanceof Error ? error.message : 'D1 connection or content migration check failed'; }
  if (paypalConfiguration.credentialsConfigured && paypalConfiguration.environmentValid) {
    try { paypal = await testPayPalConnection(event); }
    catch (error) { paypalError = error instanceof Error ? error.message : 'PayPal connection failed'; }
  }
  if (config.cloudflareAccountId && config.cloudflareApiToken) {
    try {
      const response = await $fetch<{ success?: boolean; errors?: Array<{ message?: string }> }>(
        `https://api.cloudflare.com/client/v4/accounts/${config.cloudflareAccountId}/stream`,
        { headers: { Authorization: `Bearer ${config.cloudflareApiToken}` }, timeout: 8_000 },
      );
      streamApi = Boolean(response.success);
      if (!streamApi) streamApiError = response.errors?.map((item) => item.message).filter(Boolean).join('; ') || 'Cloudflare Stream API validation failed';
    } catch (error) {
      const value = error as { data?: { errors?: Array<{ message?: string }> }; statusMessage?: string };
      const detail = value.data?.errors?.map((item) => item.message).filter(Boolean).join('; ')
        || value.statusMessage || (error instanceof Error ? error.message : 'Cloudflare Stream API validation failed');
      streamApiError = detail === 'Authentication error'
        ? 'Authentication error：Token 有效但无权访问此账号的 Stream API，请检查 Account ID 是否匹配，并给 Token 添加 Account / Stream / Edit 权限'
        : detail;
    }
  } else if (missingCloudflareFields.streamApi.length) {
    streamApiError = `缺少 ${missingCloudflareFields.streamApi.join(' / ')}`;
  }
  return ok({
    checkedAt: new Date().toISOString(),
    cloudflare: {
      database, databaseError, databaseSchema,
      mode: (event.context.cloudflare as { env?: { DB?: unknown } } | undefined)?.env?.DB ? 'D1 binding' : 'Cloudflare REST API',
      accountConfigured: Boolean(config.cloudflareAccountId), databaseConfigured: Boolean(config.cloudflareD1DatabaseId), apiTokenConfigured: Boolean(config.cloudflareApiToken),
      streamApiConfigured: streamApi,
      streamApiError,
      streamCustomerCodeConfigured: Boolean(config.cloudflareStreamCustomerCode),
      streamWebhookConfigured: Boolean(config.cloudflareStreamWebhookSecret),
      uploadConfigured: Boolean(database && config.cloudflareMediaWorkerUrl && config.cloudflareMediaWorkerSecret && streamApi),
      mediaConfigured: Boolean(config.cloudflareMediaWorkerUrl && config.cloudflareMediaWorkerSecret
        && streamApi && config.cloudflareMediaSigningSecret && config.cloudflareStreamWebhookSecret),
      mediaWorkerConfigured: Boolean(config.cloudflareMediaWorkerUrl && config.cloudflareMediaWorkerSecret),
      streamConfigured: streamApi,
      mediaSigningConfigured: Boolean(config.cloudflareMediaSigningSecret),
      customHostnamesConfigured: domainAutomation.automationConfigured,
      customHostnamesMissingFields: domainAutomation.missingFields,
      missingFields: missingCloudflareFields,
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
