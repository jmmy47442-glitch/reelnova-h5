import { mediaWorkerRequest } from '~/server/utils/media-pipeline';
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
    mediaWorker: [
      !config.cloudflareMediaWorkerUrl ? 'CLOUDFLARE_MEDIA_WORKER_URL' : '',
      !config.cloudflareMediaWorkerSecret ? 'CLOUDFLARE_MEDIA_WORKER_SECRET' : '',
    ].filter(Boolean),
    playback: [
      !config.cloudflareMediaSigningSecret ? 'CLOUDFLARE_MEDIA_SIGNING_SECRET' : '',
    ].filter(Boolean),
  };
  let database = false;
  let databaseError: string | null = null;
  let databaseSchema: DatabaseSchemaHealth | null = null;
  let paypal = false;
  let paypalError: string | null = null;
  let mediaWorkerReady = false;
  let mediaWorkerError: string | null = null;
  let transcoderReady = false;
  let transcoderError: string | null = null;
  let delivery: 'r2-mp4' | 'r2-hls' = 'r2-mp4';
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
  if (database && !missingCloudflareFields.mediaWorker.length) {
    try {
      const health = await mediaWorkerRequest<{ ready: boolean; delivery: string; transcoderReady?: boolean; transcoderError?: string }>(event, '/health', {});
      mediaWorkerReady = health.ready && ['r2-mp4', 'r2-hls'].includes(health.delivery);
      delivery = health.delivery === 'r2-hls' ? 'r2-hls' : 'r2-mp4';
      transcoderReady = health.transcoderReady === true;
      transcoderError = health.transcoderError || null;
      if (!mediaWorkerReady) mediaWorkerError = '请部署最新的 R2/HLS 媒体 Worker';
    } catch (error) { mediaWorkerError = error instanceof Error ? error.message : 'Media Worker connection failed'; }
  }
  return ok({
    checkedAt: new Date().toISOString(),
    cloudflare: {
      database, databaseError, databaseSchema,
      mode: (event.context.cloudflare as { env?: { DB?: unknown } } | undefined)?.env?.DB ? 'D1 binding' : 'Cloudflare REST API',
      accountConfigured: Boolean(config.cloudflareAccountId), databaseConfigured: Boolean(config.cloudflareD1DatabaseId), apiTokenConfigured: Boolean(config.cloudflareApiToken),
      delivery,
      mediaWorkerReady, mediaWorkerError, transcoderReady, transcoderError,
      uploadConfigured: Boolean(database && mediaWorkerReady),
      mediaConfigured: Boolean(database && mediaWorkerReady && config.cloudflareMediaSigningSecret),
      mediaWorkerConfigured: Boolean(config.cloudflareMediaWorkerUrl && config.cloudflareMediaWorkerSecret),
      mediaSigningConfigured: Boolean(config.cloudflareMediaSigningSecret),
      customHostnamesConfigured: domainAutomation.automationConfigured,
      customHostnamesMissingFields: domainAutomation.missingFields,
      domainMode: domainAutomation.mode,
      cloudflareForSaasEnabled: domainAutomation.saasEnabled,
      cloudflareForSaasStatus: domainAutomation.saasStatus,
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
