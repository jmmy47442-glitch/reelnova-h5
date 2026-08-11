import { ok } from '~/server/utils/response';
import { getDomainConfig } from '~/server/utils/managed-content';
import { requireSuperAdmin } from '~/server/utils/admin-auth';

export default defineEventHandler(async (event) => {
  requireSuperAdmin(event);
  return ok({
    items: await getDomainConfig(event),
    cnameTarget: String(useRuntimeConfig(event).domainCnameTarget),
  });
});
