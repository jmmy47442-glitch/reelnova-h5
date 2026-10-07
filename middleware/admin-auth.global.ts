import { getAdminPagePermission } from '~/shared/admin-rbac';

export default defineNuxtRouteMiddleware(async (to) => {
  if (!to.path.startsWith('/admin')) return;

  if (to.path === '/admin/register') return navigateTo('/admin/login');

  const { isAuthenticated, landingPath, can, fetchSession } = useAdminAuth();
  // The server still checks the HttpOnly session cookie on every admin API
  // request. Re-fetching it for every client-side route transition serialized
  // navigation behind an extra network round trip (and made a slow edge/API
  // look like a slow page). Fetch once per app session; a full reload starts a
  // fresh check.
  await fetchSession();

  if (to.path === '/admin/login') {
    if (isAuthenticated.value) return navigateTo(landingPath.value);
    return;
  }

  if (!isAuthenticated.value) {
    return navigateTo({ path: '/admin/login', query: { redirect: to.fullPath } });
  }

  const permission = getAdminPagePermission(to.path);
  if (!can(permission)) return navigateTo(landingPath.value);
});
