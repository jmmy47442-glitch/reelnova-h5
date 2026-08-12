import { ok } from '~/server/utils/response';
import { recordAdminAudit } from '~/server/utils/admin-audit';
import { requireSuperAdmin } from '~/server/utils/admin-auth';
import {
  getCloudflareDomainAutomationStatus,
  saveCloudflareDomainAutomationSettings,
  testCloudflareZoneAccess,
} from '~/server/utils/cloudflare-domains';

const hostnamePattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

export default defineEventHandler(async (event) => {
  requireSuperAdmin(event);
  const body = await readBody<{ zoneId?: string; cnameTarget?: string }>(event);
  const zoneId = String(body?.zoneId || '').trim().toLowerCase();
  const cnameTarget = String(body?.cnameTarget || '').trim().toLowerCase().replace(/\.$/, '');

  if (!/^[a-f0-9]{32}$/i.test(zoneId)) {
    throw createError({ statusCode: 400, statusMessage: 'Zone ID must be a 32-character hexadecimal value' });
  }
  if (!hostnamePattern.test(cnameTarget) || cnameTarget.length > 253) {
    throw createError({ statusCode: 400, statusMessage: 'CNAME target must be a valid hostname without protocol or path' });
  }

  const before = await getCloudflareDomainAutomationStatus(event);
  if (before.apiTokenConfigured) await testCloudflareZoneAccess(event, zoneId);
  await saveCloudflareDomainAutomationSettings(event, { zoneId, cnameTarget });
  const after = await getCloudflareDomainAutomationStatus(event);
  await recordAdminAudit(event, {
    module: '域名管理', action: '更新接入设置', target: cnameTarget,
    detail: `Zone ID ${before.zoneId || '未配置'} → ${zoneId}；CNAME ${before.cnameTarget || '未配置'} → ${cnameTarget}；API Token 未写入数据库`,
    risk: '高风险',
  });
  return ok({
    settings: { zoneId: after.zoneId, cnameTarget: after.cnameTarget, apiTokenConfigured: after.apiTokenConfigured },
    missingFields: after.missingFields,
    automationConfigured: after.automationConfigured,
  });
});
