import { getDomainConfig } from '../utils/managed-content';

const requestHostname = (event: Parameters<typeof getDomainConfig>[0]) => {
  const forwarded = getHeader(event, 'x-forwarded-host')?.split(',')[0]?.trim();
  return (forwarded || getHeader(event, 'host') || '').toLowerCase().replace(/:\d+$/, '');
};

export default defineEventHandler(async (event) => {
  const host = requestHostname(event);
  if (!host) return;
  if (host === 'www.iseedrama.com') {
    const requestUrl = getRequestURL(event);
    return sendRedirect(event, `https://iseedrama.com${requestUrl.pathname}${requestUrl.search}`, 301);
  }
  const domains = await getDomainConfig(event);
  const source = domains.find((item) => item.host === host && item.role !== '主域名' && item.redirect
    && item.verification === '已验证' && item.certificate === '正常');
  if (!source) return;
  const primary = domains.find((item) => item.role === '主域名' && item.verification === '已验证' && item.certificate === '正常');
  if (!primary || primary.host === host) return;
  const requestUrl = getRequestURL(event);
  return sendRedirect(event, `https://${primary.host}${requestUrl.pathname}${requestUrl.search}`, 301);
});
