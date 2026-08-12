import { ok } from '~/server/utils/response';
import { recordAdminAudit } from '~/server/utils/admin-audit';
import { getDomainConfig, saveDomainConfig } from '~/server/utils/managed-content';
import { requireSuperAdmin } from '~/server/utils/admin-auth';
import { applyCloudflareHostnameState, deleteCloudflareCustomHostname, ensureCloudflareCustomHostname } from '~/server/utils/cloudflare-domains';
import type { DomainConfig } from '~/types/admin';

export default defineEventHandler(async (event) => {
  requireSuperAdmin(event);
  const body = await readBody<{ host?: string }>(event);
  const host = String(body?.host || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');
  if (!/^(?:[a-z0-9-]+\.)+[a-z]{2,}$/.test(host)) throw createError({ statusCode: 400, statusMessage: 'Invalid domain name' });
  const items = await getDomainConfig(event);
  if (items.some((item) => item.host === host)) throw createError({ statusCode: 409, statusMessage: 'Domain already exists' });
  const created: DomainConfig = {
    id: `dom-${crypto.randomUUID().slice(0, 8)}`,
    host,
    role: '备用域名' as const,
    verification: '待验证' as const,
    certificate: '未签发' as const,
    redirect: false,
    updatedAt: new Date().toISOString(),
  };
  const customHostname = await ensureCloudflareCustomHostname(event, host);
  applyCloudflareHostnameState(created, customHostname);
  items.push(created);
  try {
    await saveDomainConfig(event, items);
  } catch (error) {
    try { await deleteCloudflareCustomHostname(event, customHostname.id); } catch { /* Preserve the storage failure. */ }
    throw error;
  }
  await recordAdminAudit(event, {
    module: '域名管理', action: '绑定自定义域名', target: host,
    detail: `Cloudflare Custom Hostname ${customHostname.id} 已创建，等待 DNS 与证书验证`, risk: '高风险',
  });
  return ok(created);
});
