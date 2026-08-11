import { useUserAuth } from '~/composables/useUserAuth';
import { useAccountSettings } from '~/composables/useAccountSettings';

export default defineNuxtRouteMiddleware(async (to) => {
  if (to.path.startsWith('/admin')) return;

  const isEntryRoute = to.path === '/login' || to.path === '/register';
  const { isAuthenticated, fetchSession } = useUserAuth();
  const accountSettings = useAccountSettings();
  await fetchSession();

  const getRedirect = () => typeof to.query.redirect === 'string'
    && to.query.redirect.startsWith('/')
    && !to.query.redirect.startsWith('/admin')
    ? to.query.redirect
    : '/';

  if (isEntryRoute) {
    if (isAuthenticated.value) return navigateTo(getRedirect());
    return;
  }

  if (!isAuthenticated.value) {
    return navigateTo({ path: '/login', query: { redirect: to.fullPath } });
  }
  await accountSettings.fetchSettings();
});
