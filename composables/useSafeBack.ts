const authRoutePattern = /^\/(?:login|register)(?:[/?#]|$)/;

export const useSafeBack = (fallback: () => string) => {
  const router = useRouter();

  return () => {
    const previousRoute = import.meta.client ? window.history.state?.back : null;
    if (typeof previousRoute === 'string' && previousRoute.startsWith('/') && !authRoutePattern.test(previousRoute)) {
      router.back();
      return;
    }
    return navigateTo(fallback(), { replace: true });
  };
};
