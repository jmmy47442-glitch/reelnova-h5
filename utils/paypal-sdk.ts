// One SDK instance per browser/client ID. Concurrent checkout mounts share the load.
let loading: Promise<any> | undefined;
let loadedClientId = '';

export const loadPayPalSdk = (clientId: string): Promise<any> => {
  if (loadedClientId && loadedClientId !== clientId) {
    return Promise.reject(new Error('Payment configuration changed. Reload the page to continue.'));
  }
  if (loading) return loading;
  loadedClientId = clientId;
  loading = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    const query = new URLSearchParams({
      'client-id': clientId, currency: 'USD', intent: 'capture',
      components: 'buttons,card-fields,applepay', locale: 'en_US',
    });
    script.src = `https://www.paypal.com/sdk/js?${query}`;
    script.async = true;
    script.dataset.reelnovaPaypal = 'true';
    const finish = (error?: Error) => {
      window.clearTimeout(timer);
      script.onload = script.onerror = null;
      if (error) {
        script.remove();
        loading = undefined;
        loadedClientId = '';
        reject(error);
      } else resolve((window as any).paypal);
    };
    const timer = window.setTimeout(() => finish(new Error('Payment options took too long to load.')), 10_000);
    script.onload = () => finish((window as any).paypal ? undefined : new Error('Payment SDK unavailable.'));
    script.onerror = () => finish(new Error('Payment options could not be loaded.'));
    document.head.appendChild(script);
  });
  return loading;
};

export const supportsApplePay = (): boolean => {
  try {
    const session = (window as any).ApplePaySession;
    return Boolean(window.isSecureContext && session?.supportsVersion(4) && session.canMakePayments());
  } catch { return false; }
};

// Warm eligibility while the customer reads the series page. Never open a
// wallet, validate a merchant session, or create an order during preparation.
let appleSetup: Promise<{ applepay: any; config: any }> | undefined;
let appleClientId = '';
let appleExpiresAt = 0;
export const prepareApplePay = (clientId: string) => {
  if (appleSetup && appleClientId === clientId && Date.now() < appleExpiresAt) return appleSetup;
  appleClientId = clientId;
  appleExpiresAt = Date.now() + 60_000;
  const task = (async () => {
    const paypal = await loadPayPalSdk(clientId);
    const applepay = paypal.Applepay();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const config = await Promise.race([
        applepay.config(),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Apple Pay configuration timed out.')), 10_000); }),
      ]);
      return { applepay, config };
    } finally { clearTimeout(timer); }
  })();
  appleSetup = task;
  void task.catch(() => { if (appleSetup === task) appleSetup = undefined; });
  return task;
};
