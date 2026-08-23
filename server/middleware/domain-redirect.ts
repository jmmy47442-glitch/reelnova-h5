import { getDomainConfig } from '../utils/managed-content';

const requestHostname = (event: Parameters<typeof getDomainConfig>[0]) => {
  const forwarded = getHeader(event, 'x-forwarded-host')?.split(',')[0]?.trim();
  return (forwarded || getHeader(event, 'host') || '').toLowerCase().replace(/:\d+$/, '');
};

const isApplicationResource = (pathname: string) => pathname === '/api'
  || pathname.startsWith('/api/')
  || pathname.startsWith('/_nuxt/')
  || pathname.startsWith('/posters/')
  || pathname.startsWith('/__nuxt_error')
  || /\/[^/]+\.[a-z0-9]+$/i.test(pathname);

export default defineEventHandler(async (event) => {
  if (event.method !== 'GET') return;
  const host = requestHostname(event);
  if (!host) return;
  if (host === 'www.iseedrama.com') {
    const requestUrl = getRequestURL(event);
    return sendRedirect(event, `https://iseedrama.com${requestUrl.pathname}${requestUrl.search}`, 301);
  }
  // Domain redirects only apply to document requests. Skipping API, payload,
  // and static asset requests avoids a D1 lookup on every route transition.
  const requestUrl = getRequestURL(event);
  if (isApplicationResource(requestUrl.pathname)) return;
  const domains = await getDomainConfig(event);
  const source = domains.find((item) => item.host === host && item.role !== '主域名' && item.redirect
    && item.verification === '已验证' && item.certificate === '正常');
  if (!source) return;
  const primary = domains.find((item) => item.role === '主域名' && item.verification === '已验证' && item.certificate === '正常');
  if (!primary || primary.host === host) return;
  return sendRedirect(event, `https://${primary.host}${requestUrl.pathname}${requestUrl.search}`, 301);
});
