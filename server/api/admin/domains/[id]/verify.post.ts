import { ok } from '~/server/utils/response';
import { recordAdminAudit } from '~/server/utils/admin-audit';
import { getDomainConfig, saveDomainConfig } from '~/server/utils/managed-content';
import { requireSuperAdmin } from '~/server/utils/admin-auth';

interface DnsAnswer { type: number; data: string }
interface DnsResponse { Status: number; Answer?: DnsAnswer[] }

export default defineEventHandler(async (event) => {
  requireSuperAdmin(event);
  const id = getRouterParam(event, 'id') || '';
  const items = await getDomainConfig(event);
  const domain = items.find((item) => item.id === id);
  if (!domain) throw createError({ statusCode: 404, statusMessage: 'Domain not found' });
  const target = String(useRuntimeConfig(event).domainCnameTarget).toLowerCase().replace(/\.$/, '');
  const dns = await $fetch<DnsResponse>('https://cloudflare-dns.com/dns-query', {
    query: { name: domain.host, type: 'CNAME' },
    headers: { accept: 'application/dns-json' },
    timeout: 8_000,
  });
  const verified = dns.Status === 0 && Boolean(dns.Answer?.some((answer) => answer.type === 5 && answer.data.toLowerCase().replace(/\.$/, '') === target));
  domain.verification = verified ? '已验证' : '验证失败';
  domain.certificate = '未签发';
  if (verified) {
    try {
      await $fetch.raw(`https://${domain.host}`, { method: 'HEAD', timeout: 5_000, retry: 0, ignoreResponseError: true });
      domain.certificate = '正常';
    } catch {
      // DNS is valid; certificate provisioning can finish asynchronously.
    }
  }
  domain.updatedAt = new Date().toISOString();
  await saveDomainConfig(event, items);
  await recordAdminAudit(event, { module: '域名管理', action: '验证域名', target: domain.host, detail: verified ? 'CNAME 验证通过' : `CNAME 未指向 ${target}`, risk: '高风险' });
  if (!verified) throw createError({ statusCode: 409, statusMessage: `CNAME must point to ${target}` });
  return ok(domain);
});
