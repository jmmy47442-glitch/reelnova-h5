<script setup lang="ts">
import { Check, CircleAlert, Clock3, CreditCard, LoaderCircle, ShieldCheck, X } from 'lucide-vue-next';
import { useUserAuth } from '~/composables/useUserAuth';
import { useAnalytics } from '~/composables/useAnalytics';
import { loadPayPalSdk } from '~/utils/paypal-sdk';
import type { Order, OrderStatus, Series } from '~/types/content';

type PaymentMethod = 'paypal' | 'card' | 'apple_pay';
const props = defineProps<{ series: Series; open: boolean }>();
const emit = defineEmits<{ close: []; unlocked: [] }>();
const api = useContentApi();
const { track } = useAnalytics();
const { formatPrice } = useFormatters();
const route = useRoute();
const { isAuthenticated } = useUserAuth();
const { data: paymentConfig, refresh: refreshPaymentConfig } = await useAsyncData('paypal-checkout-config', () => api.getPayPalConfig());
const status = ref<OrderStatus>('pending');
const error = ref('');
const paymentMethod = ref<PaymentMethod>('paypal');
const paypalContainer = ref<HTMLElement | null>(null);
const cardContainer = ref<HTMLElement | null>(null);
const loading = ref(false);
const busy = ref(false);
const sdkFailed = ref(false);
const cardReady = ref(false);
const cardMessage = ref('');
const cardValidationAttempted = ref(false);
const cardValidationMessage = ref('');
const cardFieldErrors = ref<Record<string, string>>({});
const appleReady = ref(false);
const appleMessage = ref('');
const activeOrder = shallowRef<Order | null>(null);
const conflictPayPalId = ref('');
const checkoutKey = ref('');
const paypalAvailable = computed(() => Boolean(paymentConfig.value?.available && paymentConfig.value.clientId));
const purchasable = computed(() => props.series.price > 0);
const processing = computed(() => busy.value || status.value === 'processing');
const applePayLoadFailureMessage = () => {
  const hostname = window.location.hostname.toLowerCase();
  const isLocalhost = hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '127.0.0.1' || hostname === '::1';
  return isLocalhost
    ? 'Apple Pay cannot be tested on localhost. Open the verified HTTPS site in Safari with a card in Wallet.'
    : 'Apple Pay could not be loaded. Please use card or PayPal.';
};
let generation = 0;
let buttons: any;
let cardFields: any;
let renderedFields: any[] = [];
let applepay: any;
let appleConfig: any;
let appleSession: any;
let pollTimer: ReturnType<typeof setTimeout> | undefined;
let polls = 0;
let capturePromise: Promise<void> | undefined;
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
  if (processing.value || method === paymentMethod.value) return;
  if (activeOrder.value?.paypalOrderId || conflictPayPalId.value) {
    await cancelCheckout();
    if (activeOrder.value || conflictPayPalId.value || status.value === 'paid') return;
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
        session.abort(); appleSession = null; busy.value = false;
        showFailure(reason, 'Apple Pay is unavailable for this checkout. Please choose another payment method.');
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
const initialize = async () => {
  if (!props.open || !isAuthenticated.value || !purchasable.value || loading.value) return;
  const currentGeneration = generation;
  loading.value = true;
  try {
    await refreshPaymentConfig();
    if (currentGeneration !== generation || !paypalAvailable.value) return;
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
        await buttons.render(paypalContainer.value);
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
          await Promise.all(fields.map(({ hostedField, container }) => hostedField.render(container)));
          if (currentGeneration === generation) cardReady.value = true;
        } else cardMessage.value = 'Direct card payment is unavailable for this checkout. You can still use PayPal.';
      } catch { if (currentGeneration === generation) cardMessage.value = 'Card fields could not be loaded. Please reopen checkout to retry or use PayPal.'; }
    };
    const initializeApplePay = async () => {
      try {
        const ApplePaySession = (window as any).ApplePaySession;
        if (window.isSecureContext && ApplePaySession?.supportsVersion(4) && ApplePaySession.canMakePayments()) {
          applepay = paypal.Applepay();
          appleConfig = await applepay.config();
          if (currentGeneration !== generation) return;
          appleReady.value = Boolean(appleConfig.isEligible);
          if (!appleReady.value) appleMessage.value = 'Apple Pay is unavailable for this checkout. Please use card or PayPal.';
        } else appleMessage.value = 'Use a compatible Apple device with a card in Wallet to pay with Apple Pay.';
      } catch { if (currentGeneration === generation) appleMessage.value = applePayLoadFailureMessage(); }
    };
    await Promise.all([
      initializePayPalButtons(),
      initializeCardFields(),
      initializeApplePay(),
    ]);
  } catch {
    sdkFailed.value = true;
    cardMessage.value = 'Card payment could not be loaded. Please reopen checkout to retry.';
    appleMessage.value = 'Apple Pay could not be loaded. Please reopen checkout to retry.';
    error.value = 'Payment options could not be loaded. You can continue to secure PayPal checkout.';
  } finally { if (currentGeneration === generation) loading.value = false; }
};
const checkout = async () => {
  if (!isAuthenticated.value) { emit('close'); await navigateTo({ path: '/login', query: { redirect: route.fullPath } }); return; }
  if (processing.value || !paypalAvailable.value) return;
  busy.value = true;
  try {
    const order = await createOrder('paypal');
    if (!order.approvalUrl) throw new Error('PayPal approval URL missing');
    window.location.assign(order.approvalUrl);
  } catch (reason) { showFailure(reason, 'Checkout could not be loaded. Check your connection and try again.'); }
  finally { busy.value = false; }
};
const dispose = () => {
  generation++;
  clearTimeout(pollTimer);
  try { appleSession?.abort(); } catch { /* Session may already be complete. */ }
  appleSession = null;
  void Promise.resolve(buttons?.close()).catch(() => undefined);
  for (const field of renderedFields) { try { void Promise.resolve(field.close?.()).catch(() => undefined); } catch { /* Detached iframe. */ } }
  renderedFields = []; buttons = null; cardFields = null;
  loading.value = false; cardReady.value = false; appleReady.value = false;
  cardValidationAttempted.value = false; cardValidationMessage.value = ''; cardFieldErrors.value = {};
};
const close = () => { if (!busy.value) emit('close'); };
watch(() => props.open, (open) => {
  if (!import.meta.client) return;
  if (!open) { dispose(); return; }
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
            <div v-if="error" class="inline-error" role="alert"><CircleAlert :size="18" /><span>{{ error }} <a href="mailto:support@iseedrama.com?subject=Payment%20support">Contact support</a></span></div>
            <div class="paypal-slot" :aria-busy="loading || processing">
              <template v-if="purchasable && paypalAvailable">
                <div class="payment-methods" role="group" aria-label="Payment method">
                  <button v-for="(label, method) in methodLabels" :key="method" type="button" :aria-label="label" :disabled="processing" :aria-pressed="paymentMethod === method" :class="['payment-method', { 'is-active': paymentMethod === method }]" @click="selectMethod(method)">
                    <img v-if="method === 'paypal'" class="payment-method__brand" src="/payment/paypal-mark.svg" width="20" height="20" alt="" aria-hidden="true" />
                    <CreditCard v-else-if="method === 'card'" :size="16" aria-hidden="true" />
                    <img v-else class="payment-method__brand" src="/payment/apple-pay-mark.svg" width="44" height="28" alt="" aria-hidden="true" />
                    <span v-if="method !== 'apple_pay'">{{ label }}</span>
                  </button>
                </div>
                <p v-if="loading" class="checkout-hint" role="status"><LoaderCircle class="spin" :size="16" /> Loading secure payment options…</p>
                <div v-show="paymentMethod === 'paypal'">
                  <div v-show="!sdkFailed" ref="paypalContainer" class="paypal-buttons" aria-label="PayPal checkout" />
                  <button v-if="sdkFailed" class="button button--primary button--wide" type="button" :disabled="processing" @click="checkout">Continue to PayPal</button>
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
                </div>
                <button v-if="conflictPayPalId || activeOrder?.paypalOrderId" class="checkout-cancel" type="button" :disabled="processing" @click="cancelCheckout">Cancel current checkout</button>
              </template>
              <div v-else class="payment-unavailable" role="status"><Clock3 :size="19" /><div><strong>Checkout unavailable</strong><span>Please try again later.</span></div></div>
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
