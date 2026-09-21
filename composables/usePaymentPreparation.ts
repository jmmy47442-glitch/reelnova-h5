import { loadPayPalSdk, prepareApplePay, supportsApplePay } from '~/utils/paypal-sdk';

type PaymentConfig = Awaited<ReturnType<ReturnType<typeof useContentApi>['getPayPalConfig']>>;
export type PreparedPaymentConfig = PaymentConfig & { fetchedAt: number };

let configRequest: Promise<PreparedPaymentConfig> | undefined;

export const usePaymentPreparation = () => {
  const api = useContentApi();
  const cachedPaymentConfig = useState<PreparedPaymentConfig | null>('paypal-preparation-config', () => null);

  const getPaymentConfig = async () => {
    const cached = cachedPaymentConfig.value;
    if (cached?.available && Date.now() - cached.fetchedAt < 60_000) return cached;
    if (configRequest) return configRequest;

    const request = (async () => {
      const config = { ...await api.getPayPalConfig(), fetchedAt: Date.now() };
      cachedPaymentConfig.value = config;
      return config;
    })();
    configRequest = request;
    try {
      return await request;
    } finally {
      if (configRequest === request) configRequest = undefined;
    }
  };

  const preloadPaymentOptions = async () => {
    const config = await getPaymentConfig();
    if (!config.available || !config.clientId) return config;
    await loadPayPalSdk(config.clientId);
    if (supportsApplePay()) await prepareApplePay(config.clientId);
    return config;
  };

  return { cachedPaymentConfig, getPaymentConfig, preloadPaymentOptions };
};
