import { ok } from '~/server/utils/response';
import { recordAdminAudit } from '~/server/utils/admin-audit';
import { d1First, d1Run, hasD1Connection } from '~/server/utils/cloudflare-d1';
import {
  getActivePayPalEnvironment,
  getPayPalConfigurationStatus,
  setActivePayPalEnvironment,
  testPayPalConnection,
  type PayPalEnvironment,
} from '~/server/utils/paypal';
import { requireSuperAdmin } from '~/server/utils/admin-auth';

export default defineEventHandler(async (event) => {
  requireSuperAdmin(event);
  const body = await readBody<{ environment?: PayPalEnvironment }>(event);
  const environment = body?.environment;
  if (environment !== 'sandbox' && environment !== 'production') {
    throw createError({ statusCode: 400, statusMessage: 'PayPal environment must be sandbox or production' });
  }
  if (!hasD1Connection(event)) throw createError({ statusCode: 503, statusMessage: 'Cloudflare D1 is required to switch PayPal environment' });

  const before = await getActivePayPalEnvironment(event);
  if (before === environment) return ok({ environment, changed: false });

  const configuration = await getPayPalConfigurationStatus(event);
  const target = configuration.environments[environment];
  if (!target.credentialsConfigured || !target.browserClientConfigured || !target.clientIdsMatch || !target.webhookConfigured) {
    throw createError({ statusCode: 409, statusMessage: `PayPal ${environment} credentials, browser Client ID and Webhook ID must be complete and consistent` });
  }

  const activePayments = await d1First<{ value: number }>(event, `SELECT COUNT(*) AS value FROM orders
    WHERE status IN ('pending', 'processing', 'refunding', 'risk_review')`);
  if (Number(activePayments?.value || 0) > 0) {
    throw createError({ statusCode: 409, statusMessage: 'Resolve processing payments, refunds and risk-review orders before switching PayPal environment' });
  }

  await testPayPalConnection(event, environment);
  // Orders created before migration 0016 belong to the environment that is
  // active immediately before the first switch.
  await d1Run(event, 'UPDATE orders SET paypal_environment = ? WHERE paypal_environment IS NULL', [before]);
  await setActivePayPalEnvironment(event, environment);
  await recordAdminAudit(event, {
    module: '支付配置', action: '切换运行环境', target: 'PayPal',
    detail: `${before} → ${environment}；目标环境凭据已通过 PayPal OAuth 验证`, risk: '高风险',
  });
  return ok({ environment, changed: true });
});
