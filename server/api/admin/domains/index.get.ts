import { ok } from '~/server/utils/response';
import { getDomainConfig } from '~/server/utils/managed-content';
import { requireSuperAdmin } from '~/server/utils/admin-auth';
import { getCloudflareDomainAutomationStatus } from '~/server/utils/cloudflare-domains';

export default defineEventHandler(async (event) => {
  requireSuperAdmin(event);
  const automation = await getCloudflareDomainAutomationStatus(event);
  return ok({
    items: await getDomainConfig(event),
    settings: {
      zoneId: automation.zoneId,
      cnameTarget: automation.cnameTarget,
      apiTokenConfigured: automation.apiTokenConfigured,
    },
    missingFields: automation.missingFields,
    automationConfigured: automation.automationConfigured,
  });
});
