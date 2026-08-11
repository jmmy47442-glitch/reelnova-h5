import { ok } from '~/server/utils/response';
import { recordAdminAudit } from '~/server/utils/admin-audit';
import { getDomainConfig, saveDomainConfig } from '~/server/utils/managed-content';
import { requireSuperAdmin } from '~/server/utils/admin-auth';

export default defineEventHandler(async (event) => {
  requireSuperAdmin(event);
  const id = getRouterParam(event, 'id') || '';
  const body = await readBody<{ action?: string; redirect?: boolean }>(event);
  const items = await getDomainConfig(event);
  const domain = items.find((item) => item.id === id);
  if (!domain) throw createError({ statusCode: 404, statusMessage: 'Domain not found' });

  if (body?.action === 'set-primary') {
    if (domain.verification !== '已验证' || domain.certificate !== '正常') {
      throw createError({ statusCode: 409, statusMessage: 'DNS and HTTPS must be healthy before switching the primary domain' });
    }
    const before = items.find((item) => item.role === '主域名');
    items.forEach((item) => { item.role = item.id === domain.id ? '主域名' : '备用域名'; });
    domain.redirect = false;
    domain.updatedAt = new Date().toISOString();
    await saveDomainConfig(event, items);
    await recordAdminAudit(event, { module: '域名管理', action: '切换主域名', target: domain.host, detail: `${before?.host || '—'} → ${domain.host}`, risk: '高风险' });
    return ok(domain);
  }

  if (body?.action === 'set-redirect' && typeof body.redirect === 'boolean') {
    if (domain.role === '主域名' && body.redirect) throw createError({ statusCode: 409, statusMessage: 'Primary domain cannot redirect to itself' });
    domain.redirect = body.redirect;
    domain.updatedAt = new Date().toISOString();
    await saveDomainConfig(event, items);
    await recordAdminAudit(event, { module: '域名管理', action: '更新跳转策略', target: domain.host, detail: domain.redirect ? '启用 301 到主域名' : '关闭 301 跳转', risk: '高风险' });
    return ok(domain);
  }
  throw createError({ statusCode: 400, statusMessage: 'Invalid domain action' });
});
