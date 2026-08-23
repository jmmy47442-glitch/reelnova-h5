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
  // Account preferences are presentation data. Let content routes start
  // rendering while the preference request completes; profile screens still
  // await it because they edit and display those values immediately.
  const needsSettingsBeforeRender = to.path === '/profile' || to.path.startsWith('/profile/');
  if (import.meta.server || needsSettingsBeforeRender) await accountSettings.fetchSettings();
  else void accountSettings.fetchSettings().catch(() => undefined);
});
