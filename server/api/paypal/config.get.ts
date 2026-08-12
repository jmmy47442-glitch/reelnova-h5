import { ok } from '~/server/utils/response';
import { getActivePayPalEnvironment, getPayPalConfigurationStatus } from '~/server/utils/paypal';

export default defineEventHandler(async (event) => {
  const environment = await getActivePayPalEnvironment(event);
  const config = useRuntimeConfig(event);
  const status = await getPayPalConfigurationStatus(event);
  const legacyEnvironment = config.paypalEnvironment === 'production' ? 'production' : 'sandbox';
  const specificClientId = environment === 'production'
    ? String(config.paypalProductionBrowserClientId || '')
    : String(config.paypalSandboxBrowserClientId || '');
  const clientId = specificClientId || (environment === legacyEnvironment ? String(config.public.paypalClientId || '') : '');
  return ok({
    environment,
    clientId,
    available: status.credentialsConfigured && status.browserClientConfigured && status.clientIdsMatch && status.webhookConfigured,
  });
});
