const adminHostname = 'admin.iseedrama.com';

const requestHostname = (event: Parameters<typeof getRequestURL>[0]) => {
  const forwarded = getHeader(event, 'x-forwarded-host')?.split(',')[0]?.trim();
  return (forwarded || getHeader(event, 'host') || '').toLowerCase().replace(/:\d+$/, '');
};

export default defineEventHandler((event) => {
  if (requestHostname(event) !== adminHostname) return;
  const requestUrl = getRequestURL(event);
  const { pathname } = requestUrl;
  const isAdminPath = pathname === '/admin' || pathname.startsWith('/admin/');
  const isApplicationResource = pathname === '/api'
    || pathname.startsWith('/api/')
    || pathname.startsWith('/_nuxt/')
    || pathname.startsWith('/posters/')
    || /\/[^/]+\.[a-z0-9]+$/i.test(pathname);

  if (event.method === 'GET' && !isAdminPath && !isApplicationResource) {
    return sendRedirect(event, '/admin', 302);
  }
});
