import { getAdminSession } from '../utils/admin-auth';

const loginPath = '/admin/login';

export default defineEventHandler(async (event) => {
  if (event.method !== 'GET') return;

  const requestUrl = getRequestURL(event);
  const { pathname } = requestUrl;
  const isAdminPage = pathname === '/admin' || pathname.startsWith('/admin/');
  if (!isAdminPage || pathname === loginPath) return;

  if (pathname === '/admin/register') return sendRedirect(event, loginPath, 302);
  if (await getAdminSession(event)) return;

  const redirect = `${pathname}${requestUrl.search}`;
  return sendRedirect(event, `${loginPath}?redirect=${encodeURIComponent(redirect)}`, 302);
});
