<script setup lang="ts">
import { Check, CircleAlert, Clock3, CreditCard, LoaderCircle, ShieldCheck, X } from 'lucide-vue-next';
import { useUserAuth } from '~/composables/useUserAuth';
import { useAnalytics } from '~/composables/useAnalytics';
import { loadPayPalSdk, prepareApplePay, supportsApplePay } from '~/utils/paypal-sdk';
import type { Order, OrderStatus, Series } from '~/types/content';

type PaymentMethod = 'paypal' | 'card' | 'apple_pay';
const props = defineProps<{ series: Series; open: boolean }>();
const emit = defineEmits<{ close: []; unlocked: [] }>();
const api = useContentApi();
const { track } = useAnalytics();
const { formatPrice } = useFormatters();
const route = useRoute();
const { isAuthenticated } = useUserAuth();
const cachedPaymentConfig = useState<(Awaited<ReturnType<typeof api.getPayPalConfig>> & { fetchedAt: number }) | null>('paypal-preparation-config', () => null);
const { data: paymentConfig, refresh: refreshPaymentConfig, error: paymentConfigError } = useAsyncData('paypal-checkout-config', async () => {
  const cached = cachedPaymentConfig.value;
  if (cached?.available && Date.now() - cached.fetchedAt < 60_000) return cached;
  const config = { ...await api.getPayPalConfig(), fetchedAt: Date.now() };
  cachedPaymentConfig.value = config;
  return config;
}, { server: false, lazy: true, dedupe: 'defer' });
const status = ref<OrderStatus>('pending');
const error = ref('');
const paymentMethod = ref<PaymentMethod>('paypal');
// Preparation stays silent until the customer chooses a payment button.
const methodSelected = ref(true);
const paypalContainer = ref<HTMLElement | null>(null);
const cardContainer = ref<HTMLElement | null>(null);
const loading = ref(false);
const busy = ref(false);
const sdkFailed = ref(false);
const paypalReady = ref(false);
// Keep partially rendered provider content hidden until it is ready.
const paypalView = computed(() => sdkFailed.value ? 'failed' : paypalReady.value ? 'sdk' : 'loading');
const cardReady = ref(false);
const cardMessage = ref('');
const cardValidationAttempted = ref(false);
const cardValidationMessage = ref('');
const cardFieldErrors = ref<Record<string, string>>({});
const appleReady = ref(false);
const appleMessage = ref('');
const appleLoading = ref(false);
const appleRetryable = ref(false);
const slowPayment = ref(false);
const activeOrder = shallowRef<Order | null>(null);
const conflictPayPalId = ref('');
const checkoutKey = ref('');
const paypalAvailable = computed(() => Boolean(paymentConfig.value?.available && paymentConfig.value.clientId));
// Only show progress for the selected method; other providers may still be loading.
const selectedMethodLoading = computed(() => {
  if (!methodSelected.value) return false;
  if (paymentMethod.value === 'apple_pay') return appleLoading.value || (loading.value && !appleReady.value && !appleMessage.value);
  if (paymentMethod.value === 'card') return loading.value && !cardReady.value && !cardMessage.value;
  return loading.value && paypalView.value === 'loading';
});
const withPaymentTimeout = async <T,>(task: Promise<T>): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([task, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Payment option took too long to load.')), 10_000);
    })]);
  } finally { clearTimeout(timer); }
};
const purchasable = computed(() => props.series.price > 0);
const processing = computed(() => busy.value || status.value === 'processing');
const applePayLoadFailureMessage = () => {
  const hostname = window.location.hostname.toLowerCase();
  const isLocalhost = hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '127.0.0.1' || hostname === '::1';
  return isLocalhost
    ? 'Apple Pay cannot be tested on localhost. Open the verified HTTPS site in Safari with a card in Wallet.'
    : 'Apple Pay could not connect. Try again, or open this page in Safari with a card in Wallet. You can also pay by card or PayPal.';
};
let generation = 0;
let buttons: any;
let cardFields: any;
let renderedFields: any[] = [];
let applepay: any;
let appleConfig: any;
let appleSession: any;
let pollTimer: ReturnType<typeof setTimeout> | undefined;
let slowPaymentTimer: ReturnType<typeof setTimeout> | undefined;
let polls = 0;
let capturePromise: Promise<void> | undefined;
// Payment method changes should feel instant. Keep cancellation in flight and
// let the next order creation wait for it before contacting the server.
let cancellationPromise: Promise<void> | undefined;
const methodLabels: Record<PaymentMethod, string> = { paypal: 'PayPal', card: 'Credit or debit card', apple_pay: 'Apple Pay' };
const trackPayment = (name: 'payment_success' | 'payment_failure' | 'payment_cancel') => {
  void track(name, { seriesId: props.series.id, seriesTitle: props.series.title, properties: { provider: 'paypal', paymentMethod: paymentMethod.value } });
};
const markPaid = () => {
  if (status.value === 'paid') return;
  clearTimeout(pollTimer);
  status.value = 'paid';
  error.value = '';
  trackPayment('payment_success');
  emit('unlocked');
};
const failureData = (reason: any) => reason?.data?.data || reason?.data || {};
const showFailure = (reason: unknown, fallback = 'Payment could not be completed. Please try again.') => {
  if (status.value === 'paid' || status.value === 'processing') return;
  const data = failureData(reason);
  if (data.paypalOrderId) conflictPayPalId.value = data.paypalOrderId;
  status.value = 'failed';
  error.value = ['CHECKOUT_METHOD_CONFLICT', 'CHECKOUT_ENVIRONMENT_CHANGED'].includes(data.code)
    ? 'An earlier checkout is still open. Cancel it below before choosing another payment method.'
    : data.code === 'PAYMENT_CAPTURE_DENIED' || data.code === 'PAYMENT_CAPTURE_FAILED'
      ? 'Your payment was declined. Please try another card or payment method.' : fallback;
  trackPayment('payment_failure');
};
const checkPayment = async () => {
  if (!activeOrder.value || status.value !== 'processing') return;
  const currentGeneration = generation;
  try {
    const order = await api.getOrder(activeOrder.value.orderNo);
    if (currentGeneration !== generation) return;
    activeOrder.value = order;
    if (order.status === 'paid' && order.entitlementStatus === 'granted') { markPaid(); return; }
    if (['failed', 'cancelled', 'refunded', 'refunding', 'risk_review'].includes(order.status)) {
      status.value = 'failed';
      error.value = ['refunded', 'refunding', 'risk_review'].includes(order.status)
        ? 'This payment needs review. Check your purchase history or contact support.'
        : 'Payment was not completed. You can try again.';
      if (['failed', 'cancelled'].includes(order.status)) { activeOrder.value = null; checkoutKey.value = ''; }
      return;
    }
  } catch { /* Keep the same order while the network/provider is uncertain. */ }
  if (currentGeneration !== generation || !props.open) return;
  if (++polls < 20) pollTimer = setTimeout(() => void checkPayment(), 3000);
  else error.value = 'Confirmation is taking longer than usual. Check payment status below or in Purchase history before trying again.';
};
const completePayment = (paypalOrderId: string): Promise<void> => {
  if (capturePromise) return capturePromise;
  status.value = 'processing';
  error.value = '';
  capturePromise = (async () => {
    try {
      await api.capturePayPalOrder(paypalOrderId);
      markPaid();
    } catch (reason) {
      const data = failureData(reason);
      if (['PAYMENT_CAPTURE_DENIED', 'PAYMENT_CAPTURE_FAILED', 'ORDER_NOT_PAYABLE'].includes(data.code)) {
        status.value = 'failed';
        showFailure(reason);
        if (data.code !== 'ORDER_NOT_PAYABLE') { activeOrder.value = null; checkoutKey.value = ''; }
      } else {
        // An HTTP error is not evidence of a failed charge. Do not offer a second charge.
        error.value = 'We are checking your payment. Please do not pay again yet.';
        polls = 0;
        pollTimer = setTimeout(() => void checkPayment(), 2000);
      }
      throw reason;
    } finally { capturePromise = undefined; }
  })();
  return capturePromise;
};
const createOrder = async (method: PaymentMethod) => {
  if (cancellationPromise) {
    const pendingCancellation = cancellationPromise;
    try { await pendingCancellation; } finally {
      if (cancellationPromise === pendingCancellation) cancellationPromise = undefined;
    }
  }
  checkoutKey.value ||= crypto.randomUUID();
  const order = await api.createOrder(props.series.id, checkoutKey.value, method);
  activeOrder.value = order;
  if (order.status === 'paid' && order.entitlementStatus === 'granted') { markPaid(); throw new Error('Series already unlocked'); }
  if (!['pending', 'processing'].includes(order.status) || !order.paypalOrderId) throw new Error('Checkout is not payable');
  return order;
};
const cancelCheckout = async () => {
  if (processing.value) return;
  busy.value = true;
  try {
    const id = conflictPayPalId.value || activeOrder.value?.paypalOrderId;
    if (id) {
      const result = await api.cancelPayPalOrder(id);
      if (result.status === 'paid') { markPaid(); return; }
    }
    activeOrder.value = null;
    conflictPayPalId.value = '';
    checkoutKey.value = '';
    status.value = 'cancelled';
    error.value = 'Checkout cancelled. Choose a payment method to try again.';
    trackPayment('payment_cancel');
  } catch { error.value = 'We could not confirm cancellation. Check payment status before starting another checkout.'; }
  finally { busy.value = false; }
};
const selectMethod = async (method: PaymentMethod) => {
  if (processing.value) return;
  methodSelected.value = true;
  if (method === paymentMethod.value) return;
  const id = conflictPayPalId.value || activeOrder.value?.paypalOrderId;
  if (id) {
    // Release the previous checkout without blocking the visible selection.
    // createOrder() serializes the request if the user starts paying quickly.
    activeOrder.value = null;
    conflictPayPalId.value = '';
    checkoutKey.value = '';
    const previousCancellation = cancellationPromise;
    cancellationPromise = (previousCancellation || Promise.resolve()).then(() => api.cancelPayPalOrder(id)).then((result) => {
      if (result.status === 'paid') markPaid();
    }).catch(() => {
      // The next createOrder call will surface a server-side conflict if the
      // provider could not confirm cancellation.
    });
  }
  paymentMethod.value = method;
  status.value = 'pending';
  checkoutKey.value = '';
  error.value = '';
};
const validateCardState = (state: any) => {
  const messages: Record<string, string> = {};
  const fields = [
    ['cardNameField', 'name', 'Enter the name shown on your card.'],
    ['cardNumberField', 'number', 'Enter a valid card number.'],
    ['cardExpiryField', 'expiry', 'Enter a valid expiration date (MM/YY).'],
    ['cardCvvField', 'cvv', 'Enter the 3- or 4-digit security code on your card.'],
  ];
  if (!state.isFormValid) {
    for (const [key, field, message] of fields) {
      if (state.fields?.[key]?.isValid === false) messages[field] = message;
    }
  }
  if (state.errors?.includes('INELIGIBLE_CARD_VENDOR')) {
    messages.number = 'This card type is not supported for this checkout. Try another card or PayPal.';
  }
  cardFieldErrors.value = messages;
  cardValidationMessage.value = state.isFormValid ? '' : Object.keys(messages).length
    ? 'Please correct the highlighted card details before paying.'
    : 'Check your card number, expiration date (MM/YY), security code and name on card.';
};
const submitCard = async () => {
  if (!cardReady.value || processing.value) return;
  busy.value = true;
  error.value = '';
  try {
    const state = await cardFields.getState();
    cardValidationAttempted.value = true;
    validateCardState(state);
    if (!state.isFormValid) return;
    // Hosted fields keep card data out of our server. The SDK also handles 3-D Secure.
    await cardFields.submit();
  } catch (reason) { showFailure(reason, 'Card payment could not be completed. Check your details and try again.'); }
  finally { busy.value = false; }
};
const startApplePay = () => {
  if (!appleReady.value || processing.value) return;
  const ApplePaySession = (window as any).ApplePaySession;
  busy.value = true;
  error.value = '';
  let session: any;
  const walletAmount = props.series.price.toFixed(2);
  try {
    // Must run synchronously inside this click handler, before any await.
    session = new ApplePaySession(4, {
      countryCode: appleConfig.countryCode, currencyCode: 'USD',
      merchantCapabilities: appleConfig.merchantCapabilities, supportedNetworks: appleConfig.supportedNetworks,
      requiredBillingContactFields: ['postalAddress'],
      total: { label: `ReelNova · ${props.series.title}`, type: 'final', amount: walletAmount },
    });
    appleSession = session;
    session.onvalidatemerchant = async (event: any) => {
      try {
        const result = await applepay.validateMerchant({ validationUrl: event.validationURL, displayName: 'ReelNova' });
        session.completeMerchantValidation(result.merchantSession);
      } catch (reason) {
        try { session.abort(); } catch { /* The browser may have already ended the session. */ }
        appleSession = null; busy.value = false;
        const debugId = (reason as { paypalDebugId?: unknown } | null)?.paypalDebugId;
        const reference = typeof debugId === 'string' && /^[a-zA-Z0-9-]{1,64}$/.test(debugId)
          ? ` Reference: ${debugId}.` : '';
        showFailure(reason, `Apple Pay could not verify this store with the payment provider. Your card has not been charged. Please try again or contact support.${reference}`);
      }
    };
    session.onpaymentauthorized = async (event: any) => {
      let confirmed = false;
      try {
        const order = await createOrder('apple_pay');
        // Never charge an amount different from the amount authorized in the wallet.
        if (order.currency !== 'USD' || order.amount.toFixed(2) !== walletAmount) throw new Error('Price changed');
        await applepay.confirmOrder({ orderId: order.paypalOrderId, token: event.payment.token, billingContact: event.payment.billingContact });
        confirmed = true;
        session.completePayment(ApplePaySession.STATUS_SUCCESS);
        appleSession = null;
        await completePayment(order.paypalOrderId!);
      } catch (reason) {
        if (!confirmed) session.completePayment(ApplePaySession.STATUS_FAILURE);
        showFailure(reason, 'Apple Pay could not complete this payment. Please try again.');
      } finally { appleSession = null; busy.value = false; }
    };
    session.oncancel = () => { appleSession = null; busy.value = false; void cancelCheckout(); };
    session.begin();
  } catch (reason) { appleSession = null; busy.value = false; showFailure(reason, 'Apple Pay could not be opened on this device.'); }
};
const initializeApplePay = async () => {
  if (appleLoading.value || !paymentConfig.value?.clientId) return;
  const currentGeneration = generation;
  appleLoading.value = true;
  appleMessage.value = '';
  appleRetryable.value = false;
  try {
    if (!supportsApplePay()) {
      appleMessage.value = 'Use a compatible Apple device with a card in Wallet to pay with Apple Pay. If you are in an app browser, open this page in Safari, or use card or PayPal here.';
      return;
    }
    const setup = await prepareApplePay(paymentConfig.value.clientId);
    if (currentGeneration !== generation) return;
    applepay = setup.applepay;
    appleConfig = setup.config;
    appleReady.value = Boolean(appleConfig.isEligible);
    if (!appleReady.value) appleMessage.value = 'Apple Pay is unavailable for this checkout. Please use card or PayPal.';
  } catch {
    if (currentGeneration !== generation) return;
    appleRetryable.value = true;
    appleMessage.value = applePayLoadFailureMessage();
  } finally { if (currentGeneration === generation) appleLoading.value = false; }
};
const initialize = async () => {
  if (!props.open || !isAuthenticated.value || !purchasable.value || loading.value) return;
  const currentGeneration = generation;
  loading.value = true;
  sdkFailed.value = false;
  paypalReady.value = false;
  try {
    // Reuse recent configuration and any in-flight request from page entry.
    if (!paypalAvailable.value || paymentConfigError.value || Date.now() - paymentConfig.value!.fetchedAt > 60_000) {
      await refreshPaymentConfig({ dedupe: 'defer' });
    }
    if (currentGeneration !== generation) return;
    if (paymentConfigError.value) throw paymentConfigError.value;
    if (!paypalAvailable.value) return;
    await nextTick();
    const paypal = await loadPayPalSdk(paymentConfig.value!.clientId);
    if (currentGeneration !== generation || !paypalContainer.value || !cardContainer.value) return;
    sdkFailed.value = false;
    const initializePayPalButtons = async () => {
      try {
        buttons = paypal.Buttons({
          fundingSource: paypal.FUNDING.PAYPAL,
          style: { layout: 'vertical', color: 'gold', shape: 'rect', label: 'paypal', tagline: false, height: 48 },
          createOrder: async () => {
            if (processing.value) throw new Error('Payment already in progress');
            busy.value = true;
            try { return (await createOrder('paypal')).paypalOrderId; }
            catch (reason) { busy.value = false; showFailure(reason); throw reason; }
          },
          onApprove: async ({ orderID }: { orderID: string }) => {
            try { await completePayment(orderID); } finally { busy.value = false; }
          },
          onCancel: async () => { busy.value = false; await cancelCheckout(); },
          onError: (reason: unknown) => { busy.value = false; showFailure(reason); },
        });
        await withPaymentTimeout(buttons.render(paypalContainer.value));
        if (currentGeneration === generation) paypalReady.value = true;
      } catch { if (currentGeneration === generation) sdkFailed.value = true; }
    };
    const initializeCardFields = async () => {
      try {
        cardFields = paypal.CardFields?.({
          style: { input: { 'font-size': '16px', 'line-height': '24px', padding: '10px', color: '#1f2937' }, '.invalid': { color: '#b91c1c' } },
          inputEvents: { onChange: (state: any) => { if (cardValidationAttempted.value) validateCardState(state); } },
          createOrder: async () => (await createOrder('card')).paypalOrderId,
          onApprove: ({ orderID }: { orderID: string }) => completePayment(orderID),
          onError: (reason: unknown) => showFailure(reason, 'Card payment could not be completed. Please check your details.'),
        });
        if (cardFields?.isEligible()) {
          const definitions = [['NameField', 'name', 'Name on card'], ['NumberField', 'number', 'Card number'], ['ExpiryField', 'expiry', 'MM / YY'], ['CVVField', 'cvv', 'Security code']];
          const fields = definitions.map(([factory, field, label]) => ({
            hostedField: cardFields[factory]({ placeholder: label }),
            container: cardContainer.value!.querySelector(`[data-card-${field}]`),
          }));
          renderedFields.push(...fields.map(({ hostedField }) => hostedField));
          await withPaymentTimeout(Promise.all(fields.map(({ hostedField, container }) => hostedField.render(container))));
          if (currentGeneration === generation) cardReady.value = true;
        } else if (currentGeneration === generation) cardMessage.value = 'Direct card payment is unavailable for this checkout. You can still use PayPal.';
      } catch { if (currentGeneration === generation) cardMessage.value = 'Card fields could not be loaded. Please reopen checkout to retry or use PayPal.'; }
    };
    await Promise.all([
      initializePayPalButtons(),
      initializeCardFields(),
      initializeApplePay(),
    ]);
  } catch {
    if (currentGeneration !== generation) return;
    sdkFailed.value = true;
    cardMessage.value = 'Card payment could not be loaded. Please reopen checkout to retry.';
    appleMessage.value = applePayLoadFailureMessage();
    appleRetryable.value = true;
    error.value = paypalAvailable.value ? '' : 'Payment options could not be loaded. Please retry below.';
  } finally { if (currentGeneration === generation) loading.value = false; }
};
const checkout = async () => {
  emit('close');
  await navigateTo({ path: '/login', query: { redirect: route.fullPath } });
};
const dispose = () => {
  generation++;
  clearTimeout(pollTimer);
  clearTimeout(slowPaymentTimer);
  try { appleSession?.abort(); } catch { /* Session may already be complete. */ }
  appleSession = null;
  void Promise.resolve(buttons?.close()).catch(() => undefined);
  for (const field of renderedFields) { try { void Promise.resolve(field.close?.()).catch(() => undefined); } catch { /* Detached iframe. */ } }
  renderedFields = []; buttons = null; cardFields = null;
  loading.value = false; paypalReady.value = false; sdkFailed.value = false; cardReady.value = false; appleReady.value = false;
  appleLoading.value = false; appleRetryable.value = false; slowPayment.value = false;
  methodSelected.value = false;
  cardValidationAttempted.value = false; cardValidationMessage.value = ''; cardFieldErrors.value = {};
};
const retryPaymentOptions = () => {
  if (processing.value) return;
  error.value = '';
  if (paymentMethod.value === 'apple_pay' && paypalAvailable.value) { void initializeApplePay(); return; }
  dispose();
  methodSelected.value = true;
  cardMessage.value = ''; appleMessage.value = '';
  void nextTick(initialize);
};
watch([selectedMethodLoading, paymentMethod], ([pending]) => {
  clearTimeout(slowPaymentTimer);
  slowPayment.value = false;
  if (pending) slowPaymentTimer = setTimeout(() => { slowPayment.value = true; }, 2500);
});
watch([paymentConfig, isAuthenticated], () => {
  if (!import.meta.client || props.open || !isAuthenticated.value || !purchasable.value || props.series.purchased || !paypalAvailable.value) return;
  const clientId = paymentConfig.value!.clientId;
  void loadPayPalSdk(clientId).catch(() => undefined);
  if (supportsApplePay()) void prepareApplePay(clientId).catch(() => undefined);
}, { immediate: true, flush: 'post' });
const close = () => { if (!busy.value) emit('close'); };
watch(() => props.open, (open) => {
  if (!import.meta.client) return;
  if (!open) { dispose(); return; }
  methodSelected.value = true;
  void track('payment_sheet_open', { seriesId: props.series.id, seriesTitle: props.series.title });
  if (status.value === 'processing') { polls = 0; void checkPayment(); }
  else if (status.value !== 'paid') { error.value = ''; status.value = 'pending'; }
  cardMessage.value = ''; appleMessage.value = '';
  void nextTick(initialize);
}, { immediate: true });
watch(isAuthenticated, () => { if (props.open) void nextTick(initialize); });
onBeforeUnmount(dispose);
</script>

<template>
  <Teleport to="body">
    <Transition name="sheet">
      <div v-if="open && purchasable" class="sheet-backdrop" role="presentation" @click.self="close">
        <section class="unlock-sheet" role="dialog" aria-modal="true" aria-labelledby="unlock-title">
          <div class="sheet-grabber" />
          <button class="icon-button unlock-sheet__close" type="button" aria-label="Close" :disabled="busy" @click="close">
            <X :size="20" />
          </button>

          <template v-if="!isAuthenticated">
            <div class="unlock-sheet__intro">
              <img :src="series.coverUrl" alt="" />
              <div>
                <span class="eyebrow">ACCOUNT REQUIRED</span>
                <h2 id="unlock-title">Sign in to unlock</h2>
                <p>Watch the free preview first. Create an account or sign in when you are ready to buy this series.</p>
              </div>
            </div>
            <button class="button button--primary button--wide" type="button" @click="checkout">Sign in or register</button>
            <p class="legal-copy">Your preview position stays on this device.</p>
          </template>

          <div v-else v-show="status !== 'paid' && status !== 'processing'">
            <div class="unlock-sheet__intro">
              <img :src="series.coverUrl" alt="" />
              <div>
                <span class="eyebrow">FULL SERIES PASS</span>
                <h2 id="unlock-title">Unlock {{ series.title }}</h2>
                <p>Watch all {{ series.episodeCount }} episodes, including future updates.</p>
              </div>
            </div>
            <div class="price-row">
              <div>
                <span v-if="series.originalPrice" class="old-price">{{ formatPrice(series.originalPrice) }}</span>
                <strong v-if="purchasable">{{ formatPrice(series.price) }}</strong>
                <strong v-else>Not for sale</strong>
                <span v-if="purchasable"> USD · one-time</span>
              </div>
              <span class="save-pill" v-if="purchasable && series.originalPrice">Save {{ Math.round((1 - series.price / series.originalPrice) * 100) }}%</span>
            </div>
            <ul class="unlock-list">
              <li><Check :size="17" /> All paid episodes and future updates</li>
              <li><Check :size="17" /> Keep access on restored devices</li>
              <li v-if="purchasable"><Check :size="17" /> Secure card and wallet checkout</li>
            </ul>
            <div v-if="error && methodSelected" class="inline-error" role="alert"><CircleAlert :size="18" /><span>{{ error }} <a href="mailto:support@iseedrama.com?subject=Payment%20support">Contact support</a></span></div>
            <div class="paypal-slot" :aria-busy="selectedMethodLoading || processing">
              <template v-if="purchasable">
                <div v-if="false" class="payment-methods" role="group" aria-label="Payment method">
                  <button v-for="(label, method) in methodLabels" :key="method" type="button" :aria-label="label" :disabled="processing" :aria-pressed="methodSelected && paymentMethod === method" :class="['payment-method', { 'is-active': methodSelected && paymentMethod === method }]" @click="selectMethod(method)">
                    <img v-if="method === 'paypal'" class="payment-method__brand" src="/payment/paypal-mark.svg" width="20" height="20" alt="" aria-hidden="true" />
                    <CreditCard v-else-if="method === 'card'" :size="16" aria-hidden="true" />
                    <img v-else class="payment-method__brand" src="/payment/apple-pay-mark.svg" width="44" height="28" alt="" aria-hidden="true" />
                    <span v-if="method !== 'apple_pay'">{{ label }}</span>
                  </button>
                </div>
                <p v-if="false" class="checkout-hint">Choose how you would like to pay.</p>
                <div v-if="selectedMethodLoading" class="checkout-loading" role="status" aria-live="polite">
                  <LoaderCircle class="spin" :size="18" aria-hidden="true" />
                  <div><strong>Preparing {{ methodLabels[paymentMethod] }}…</strong><p>{{ slowPayment ? 'Taking longer than usual. You can choose another payment method.' : 'Connecting securely. You have not been charged.' }}</p></div>
                </div>
                <div v-show="methodSelected && paypalAvailable">
                  <div v-show="paymentMethod === 'paypal'">
                    <div v-show="paypalView === 'sdk'" ref="paypalContainer" class="paypal-buttons" aria-label="PayPal checkout" />
                    <div v-if="paypalView === 'failed'">
                      <p class="checkout-hint" role="status">PayPal could not be loaded. Please retry or choose another payment method.</p>
                      <button class="button button--ghost button--wide" type="button" :disabled="processing" @click="retryPaymentOptions">Retry PayPal</button>
                    </div>
                  </div>
                  <div v-show="paymentMethod === 'card'">
                    <div v-show="cardReady" ref="cardContainer" class="paypal-card-fields" aria-label="Credit or debit card checkout">
                      <label>Name on card <span data-card-name /><small v-if="cardFieldErrors.name" class="card-field-error">{{ cardFieldErrors.name }}</small></label>
                      <label>Card number <span data-card-number /><small v-if="cardFieldErrors.number" class="card-field-error">{{ cardFieldErrors.number }}</small></label>
                      <div class="card-fields-row">
                        <label>Expiration date <span data-card-expiry /><small v-if="cardFieldErrors.expiry" class="card-field-error">{{ cardFieldErrors.expiry }}</small></label>
                        <label>Security code <span data-card-cvv /><small v-if="cardFieldErrors.cvv" class="card-field-error">{{ cardFieldErrors.cvv }}</small></label>
                      </div>
                      <p v-if="cardValidationMessage" class="card-field-error" role="alert">{{ cardValidationMessage }}</p>
                      <button class="button button--primary button--wide" type="button" :disabled="!cardReady || processing" @click="submitCard"><LoaderCircle v-if="busy" class="spin" :size="16" /> {{ busy ? 'Processing…' : `Pay ${formatPrice(series.price)} USD` }}</button>
                      <p class="checkout-hint">Visa, Mastercard and other supported credit or debit cards. No PayPal account required.</p>
                    </div>
                    <p v-if="cardMessage" class="checkout-hint" role="status">{{ cardMessage }}</p>
                  </div>
                  <div v-show="paymentMethod === 'apple_pay'">
                    <button v-if="appleReady" class="apple-pay-button" type="button" aria-label="Buy with Apple Pay" :disabled="processing" @click="startApplePay">
                      <img class="apple-pay-button__logo" src="/payment/apple-pay-logo-white.svg" width="54" height="22" alt="" aria-hidden="true" />
                    </button>
                    <p v-if="appleMessage" class="checkout-hint" role="status">{{ appleMessage }}</p>
                    <div v-if="appleMessage && !appleLoading" class="checkout-recovery">
                      <button v-if="appleRetryable" class="button button--ghost" type="button" :disabled="processing" @click="retryPaymentOptions">Retry Apple Pay</button>
                      <button class="button button--ghost" type="button" :disabled="processing" @click="selectMethod('card')">Use credit or debit card</button>
                    </div>
                  </div>
                  <button v-if="conflictPayPalId || activeOrder?.paypalOrderId" class="checkout-cancel" type="button" :disabled="processing" @click="cancelCheckout">Cancel current checkout</button>
                </div>
                <div v-if="methodSelected && !paypalAvailable && !loading" class="payment-unavailable" role="status"><Clock3 :size="19" /><div><strong>PayPal unavailable</strong><span>Please try again later.</span><button class="button button--ghost" type="button" @click="retryPaymentOptions">Retry PayPal</button></div></div>
              </template>
            </div>
            <p class="legal-copy">By continuing, you agree to our <NuxtLink to="/terms">Terms of Service</NuxtLink> and refund terms. Final access is granted after server confirmation.</p>
          </div>

          <div v-if="isAuthenticated && status === 'processing'" class="payment-state">
            <LoaderCircle class="spin" :size="34" />
            <h2>Payment processing</h2>
            <p>We’re waiting for secure payment confirmation.</p>
            <span class="payment-state__hint">Please do not start another payment</span>
            <p v-if="error" role="status">{{ error }}</p>
            <button class="button button--primary" type="button" :disabled="busy" @click="checkPayment">Check payment status</button>
            <NuxtLink to="/profile/orders">Purchase history</NuxtLink>
          </div>

          <div v-else-if="status === 'paid'" class="payment-state payment-state--success">
            <span class="success-icon"><ShieldCheck :size="32" /></span>
            <h2>Series unlocked</h2>
            <p>Payment confirmed. Every available episode is ready to watch.</p>
          </div>
        </section>
      </div>
    </Transition>
  </Teleport>
</template>
