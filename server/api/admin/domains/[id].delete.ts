import { ok } from '~/server/utils/response';
import { recordAdminAudit } from '~/server/utils/admin-audit';
import { deleteCloudflareCustomHostname } from '~/server/utils/cloudflare-domains';
import { getDomainConfig, saveDomainConfig } from '~/server/utils/managed-content';
import { requireSuperAdmin } from '~/server/utils/admin-auth';

export default defineEventHandler(async (event) => {
  requireSuperAdmin(event);
  const id = getRouterParam(event, 'id') || '';
  const items = await getDomainConfig(event);
  const index = items.findIndex((item) => item.id === id);
  if (index < 0) throw createError({ statusCode: 404, statusMessage: 'Domain not found' });
  const domain = items[index]!;
  if (domain.role === '主域名') throw createError({ statusCode: 409, statusMessage: 'Switch the primary domain before removing it' });
  if (domain.cloudflareHostnameId) await deleteCloudflareCustomHostname(event, domain.cloudflareHostnameId);
  items.splice(index, 1);
  await saveDomainConfig(event, items);
  await recordAdminAudit(event, {
    module: '域名管理', action: '解除域名绑定', target: domain.host,
    detail: `Cloudflare Custom Hostname ${domain.cloudflareHostnameId || '未创建'} 已删除`, risk: '高风险',
  });
  return ok({ id: domain.id, host: domain.host });
});
