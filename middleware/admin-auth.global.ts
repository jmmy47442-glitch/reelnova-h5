export default defineNuxtRouteMiddleware(async (to) => {
  if (!to.path.startsWith('/admin')) return;

  if (to.path === '/admin/register') return navigateTo('/admin/login');

  const { isAuthenticated, isSuperAdmin, fetchSession } = useAdminAuth();
  await fetchSession();

  if (to.path === '/admin/login') {
    if (isAuthenticated.value) return navigateTo('/admin');
    return;
  }

  if (!isAuthenticated.value) {
    return navigateTo({ path: '/admin/login', query: { redirect: to.fullPath } });
  }

  if ((to.path.startsWith('/admin/administrators') || to.path.startsWith('/admin/domains')) && !isSuperAdmin.value) return navigateTo('/admin');
});
