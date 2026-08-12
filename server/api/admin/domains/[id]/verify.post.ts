import { ok } from '~/server/utils/response';
import { recordAdminAudit } from '~/server/utils/admin-audit';
import { getDomainConfig, saveDomainConfig } from '~/server/utils/managed-content';
import { requireSuperAdmin } from '~/server/utils/admin-auth';
import { applyCloudflareHostnameState, ensureCloudflareCustomHostname, getCloudflareDomainAutomationStatus } from '~/server/utils/cloudflare-domains';

interface DnsAnswer { type: number; data: string }
interface DnsResponse { Status: number; Answer?: DnsAnswer[] }

export default defineEventHandler(async (event) => {
  requireSuperAdmin(event);
  const id = getRouterParam(event, 'id') || '';
  const items = await getDomainConfig(event);
  const domain = items.find((item) => item.id === id);
  if (!domain) throw createError({ statusCode: 404, statusMessage: 'Domain not found' });
  const customHostname = await ensureCloudflareCustomHostname(event, domain.host, domain.cloudflareHostnameId);
  applyCloudflareHostnameState(domain, customHostname);
  domain.updatedAt = new Date().toISOString();
  await saveDomainConfig(event, items);
  const target = (await getCloudflareDomainAutomationStatus(event)).cnameTarget;
  const dns = await $fetch<DnsResponse>('https://cloudflare-dns.com/dns-query', {
    query: { name: domain.host, type: 'CNAME' },
    headers: { accept: 'application/dns-json' },
    timeout: 8_000,
  });
  const verified = dns.Status === 0 && Boolean(dns.Answer?.some((answer) => answer.type === 5 && answer.data.toLowerCase().replace(/\.$/, '') === target));
  domain.verification = verified && customHostname.status === 'active' ? '已验证' : verified ? '待验证' : '验证失败';
  domain.updatedAt = new Date().toISOString();
  await saveDomainConfig(event, items);
  await recordAdminAudit(event, {
    module: '域名管理', action: '同步域名状态', target: domain.host,
    detail: verified
      ? `CNAME 已指向 ${target}；Custom Hostname=${customHostname.status}；SSL=${customHostname.ssl?.status || 'unknown'}`
      : `CNAME 未指向 ${target}；Custom Hostname=${customHostname.status}`,
    risk: '高风险',
  });
  if (!verified) throw createError({ statusCode: 409, statusMessage: `CNAME must point to ${target}` });
  return ok(domain);
});
