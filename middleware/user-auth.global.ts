import { useUserAuth } from '~/composables/useUserAuth';
import { useAccountSettings } from '~/composables/useAccountSettings';
import { isPublicUserRoute } from '~/utils/user-route-access';

export default defineNuxtRouteMiddleware(async (to) => {
  if (to.path.startsWith('/admin')) return;

  const isEntryRoute = to.path === '/login' || to.path === '/register';
  const isPublicRoute = isPublicUserRoute(to.path);
  const { isAuthenticated, fetchSession } = useUserAuth();
  const accountSettings = useAccountSettings();
  try {
    await fetchSession();
  } catch (error) {
    // Public discovery and free playback must remain available when the
    // optional account session check is temporarily unavailable.
    if (!isPublicRoute) throw error;
  }

  const getRedirect = () => typeof to.query.redirect === 'string'
    && to.query.redirect.startsWith('/')
    && !to.query.redirect.startsWith('/admin')
    ? to.query.redirect
    : '/';

  if (isEntryRoute) {
    if (isAuthenticated.value) return navigateTo(getRedirect());
    return;
  }

  if (isPublicRoute) return;

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
