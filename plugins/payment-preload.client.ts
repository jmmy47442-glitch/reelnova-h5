import { usePaymentPreparation } from '~/composables/usePaymentPreparation';

export default defineNuxtPlugin(() => {
  const { preloadPaymentOptions } = usePaymentPreparation();
  // Start as soon as the client app boots. Checkout still owns visible errors
  // and retries, so an unavailable provider never blocks site navigation.
  void preloadPaymentOptions().catch(() => undefined);
});
