import { usePaymentPreparation } from '~/composables/usePaymentPreparation';

export default defineNuxtPlugin(() => {
  const route = useRoute();
  const start = () => {
    // The admin console never renders checkout controls. Avoid loading the
    // payment config/SDK there, where it competes with route chunks and API
    // requests during navigation.
    if (route.path.startsWith('/admin')) return;
    const { preloadPaymentOptions } = usePaymentPreparation();
    void preloadPaymentOptions().catch(() => undefined);
  };

  // Let the first page paint and settle before starting a third-party SDK
  // request. Checkout pages still get a warm SDK shortly after mount.
  if (typeof window !== 'undefined') {
    if ('requestIdleCallback' in window) {
      window.requestIdleCallback(start, { timeout: 1500 });
    } else {
      globalThis.setTimeout(start, 800);
    }
  }
});
