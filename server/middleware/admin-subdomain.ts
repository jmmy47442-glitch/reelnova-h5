const adminHostname = 'admin.iseedrama.com';

const requestHostname = (event: Parameters<typeof getRequestURL>[0]) => {
  const forwarded = getHeader(event, 'x-forwarded-host')?.split(',')[0]?.trim();
  return (forwarded || getHeader(event, 'host') || '').toLowerCase().replace(/:\d+$/, '');
};

export default defineEventHandler((event) => {
  if (requestHostname(event) !== adminHostname) return;
  const requestUrl = getRequestURL(event);
  if (requestUrl.pathname === '/') return sendRedirect(event, '/admin', 302);
});
