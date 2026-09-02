<script setup lang="ts">
import { Check, CircleAlert, Clock3, LoaderCircle, ShieldCheck, X } from 'lucide-vue-next';
import { useUserAuth } from '~/composables/useUserAuth';
import { useAnalytics } from '~/composables/useAnalytics';
import type { OrderStatus, Series } from '~/types/content';

const props = defineProps<{ series: Series; open: boolean }>();
const emit = defineEmits<{ close: []; unlocked: [] }>();
const api = useContentApi();
const { track } = useAnalytics();
const { formatPrice } = useFormatters();
const route = useRoute();
const { isAuthenticated } = useUserAuth();
const { data: paymentConfig } = await useAsyncData('paypal-checkout-config', () => api.getPayPalConfig());
const status = ref<OrderStatus>('pending');
const error = ref('');
const paypalContainer = ref<HTMLElement | null>(null);
const paypalRendered = ref(false);
const paypalRendering = ref(false);
const paypalReady = ref(false);
const sdkFailed = ref(false);
const checkoutKey = ref('');
const activePayPalOrderId = ref('');
const paypalAvailable = computed(() => Boolean(paymentConfig.value?.available && paymentConfig.value.clientId));
const purchasable = computed(() => props.series.price > 0);

const paypalWindow = () => (window as any);

const waitForPayPalScript = (script: HTMLScriptElement) => new Promise<void>((resolve, reject) => {
  let settled = false;
  const finish = (reason?: Error) => {
    if (settled) return;
    settled = true;
    window.clearTimeout(timeout);
    script.removeEventListener('load', loaded);
    script.removeEventListener('error', failed);
    reason ? reject(reason) : resolve();
  };
  const loaded = () => finish(paypalWindow().paypal ? undefined : new Error('PayPal SDK unavailable'));
  const failed = () => finish(new Error('PayPal SDK failed'));
  const timeout = window.setTimeout(() => finish(new Error('PayPal SDK timed out')), 8_000);
  script.addEventListener('load', loaded, { once: true });
  script.addEventListener('error', failed, { once: true });
});

const loadPayPalSdk = async () => {
  if (paypalWindow().paypal) return paypalWindow().paypal;
  const clientId = String(paymentConfig.value?.clientId || '');
  if (!clientId) return undefined;
  let script = document.querySelector<HTMLScriptElement>('script[data-reelnova-paypal]');
  if (!script) {
    script = document.createElement('script');
    script.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(clientId)}&currency=USD&intent=capture&components=buttons&locale=en_US`;
    script.async = true;
    script.dataset.reelnovaPaypal = 'true';
    document.head.appendChild(script);
  }
  await waitForPayPalScript(script);
  return paypalWindow().paypal;
};

const completePayment = async (paypalOrderId: string) => {
  status.value = 'processing';
  try {
    await api.capturePayPalOrder(paypalOrderId);
    status.value = 'paid';
    void track('payment_success', { seriesId: props.series.id, seriesTitle: props.series.title, properties: { provider: 'paypal' } });
    window.setTimeout(() => emit('unlocked'), 900);
  } catch (reason) {
    status.value = 'failed';
    const failure = reason as { data?: { code?: string; data?: { code?: string } } };
    const code = failure.data?.data?.code || failure.data?.code;
    error.value = code === 'PAYMENT_CAPTURE_DENIED' || code === 'PAYMENT_CAPTURE_FAILED'
      ? 'PayPal declined this payment. Choose another funding source and try again.'
      : code === 'PAYMENT_CONFIRMATION_TIMEOUT' || code === 'PAYMENT_CAPTURE_UNCONFIRMED'
        ? 'Payment confirmation is taking too long. We will keep checking before you retry.'
        : 'PayPal could not confirm the payment. Try again or contact support.';
    paypalRendered.value = false;
    paypalReady.value = false;
    checkoutKey.value = '';
    void track('payment_failure', { seriesId: props.series.id, seriesTitle: props.series.title, properties: { provider: 'paypal', stage: 'capture', reason: reason instanceof Error ? reason.message.slice(0, 120) : 'unknown' } });
    throw reason;
  }
};

const renderPayPal = async () => {
  if (!props.open || !isAuthenticated.value || !purchasable.value || !paypalAvailable.value || paypalRendered.value || paypalRendering.value || !paypalContainer.value) return;
  paypalRendering.value = true;
  try {
    const paypal = await loadPayPalSdk();
    if (!paypal || !paypalContainer.value) return;
    paypalRendered.value = true;
    await paypal.Buttons({
      fundingSource: paypal.FUNDING.PAYPAL,
      style: { layout: 'vertical', color: 'gold', shape: 'rect', label: 'paypal', tagline: false, height: 48 },
      createOrder: async () => {
        checkoutKey.value ||= crypto.randomUUID();
        void track('paypal_click', { seriesId: props.series.id, seriesTitle: props.series.title, properties: { action: 'create_order' } });
        const order = await api.createOrder(props.series.id, checkoutKey.value);
        if (order.status === 'paid') { status.value = 'paid'; window.setTimeout(() => emit('unlocked'), 500); return order.paypalOrderId || ''; }
        if (!order.paypalOrderId) throw new Error('PayPal order missing');
        activePayPalOrderId.value = order.paypalOrderId;
        return order.paypalOrderId;
      },
      onApprove: async ({ orderID }: { orderID: string }) => completePayment(orderID),
      onCancel: () => {
        status.value = 'cancelled';
        checkoutKey.value = '';
        if (activePayPalOrderId.value) void api.cancelPayPalOrder(activePayPalOrderId.value).catch(() => undefined);
        void track('payment_cancel', { seriesId: props.series.id, seriesTitle: props.series.title, properties: { provider: 'paypal' } });
        error.value = 'Payment was cancelled. No access was granted and you can start a new checkout.';
      },
      onError: () => {
        status.value = 'failed';
        paypalRendered.value = false;
        paypalReady.value = false;
        void track('payment_failure', { seriesId: props.series.id, seriesTitle: props.series.title, properties: { provider: 'paypal', stage: 'sdk' } });
        error.value ||= 'PayPal could not complete checkout. Try again or contact support.';
      },
    }).render(paypalContainer.value);
    paypalReady.value = true;
  } catch {
    paypalRendered.value = false;
    paypalReady.value = false;
    sdkFailed.value = true;
    error.value = 'PayPal buttons could not be loaded. Continue with secure PayPal checkout below.';
  } finally {
    paypalRendering.value = false;
  }
};

watch(() => props.open, (isOpen) => {
  if (isOpen) {
    void track('payment_sheet_open', { seriesId: props.series.id, seriesTitle: props.series.title });
    status.value = 'pending';
    error.value = '';
    checkoutKey.value = '';
    activePayPalOrderId.value = '';
    paypalRendered.value = false;
    paypalRendering.value = false;
    paypalReady.value = false;
    sdkFailed.value = false;
    void nextTick(renderPayPal);
  }
});

const checkout = async () => {
  if (!isAuthenticated.value) {
    emit('close');
    await navigateTo({ path: '/login', query: { redirect: route.fullPath } });
    return;
  }
  if (!purchasable.value) {
    status.value = 'failed';
    error.value = 'This series is not available for purchase because a checkout price has not been set.';
    return;
  }
  if (!paypalAvailable.value) {
    status.value = 'failed';
    error.value = 'Checkout is not available yet.';
    return;
  }

  status.value = 'processing';
  error.value = '';
  try {
    void track('paypal_click', { seriesId: props.series.id, seriesTitle: props.series.title, properties: { action: 'redirect_checkout' } });
    checkoutKey.value ||= crypto.randomUUID();
    const order = await api.createOrder(props.series.id, checkoutKey.value);
    if (order.status === 'paid') { status.value = 'paid'; emit('unlocked'); return; }
    if (!order.approvalUrl) throw new Error('PayPal approval URL missing');
    activePayPalOrderId.value = order.paypalOrderId || '';
    window.location.assign(order.approvalUrl);
  } catch (reason: unknown) {
    status.value = 'failed';
    void track('payment_failure', { seriesId: props.series.id, seriesTitle: props.series.title, properties: { provider: 'paypal', stage: 'create_order' } });
    const failure = reason as { statusCode?: number; response?: { status?: number }; data?: { code?: string; data?: { code?: string } } };
    const statusCode = failure.statusCode || failure.response?.status;
    const errorCode = failure.data?.data?.code || failure.data?.code;
    error.value = errorCode === 'PAYPAL_CONNECTION_FAILED'
      ? 'The server cannot reach PayPal. Check the server proxy or network, then try again.'
      : errorCode === 'PAYPAL_CREDENTIALS_REJECTED'
        ? 'PayPal rejected the checkout credentials. Ask the site administrator to verify the active environment.'
        : statusCode === 503
          ? 'Checkout is not available yet.'
          : 'Checkout could not be loaded. Check your connection and try again.';
  }
};

watch(paypalContainer, () => { void renderPayPal(); });
</script>

<template>
  <Teleport to="body">
    <Transition name="sheet">
      <div v-if="open" class="sheet-backdrop" role="presentation" @click.self="emit('close')">
        <section class="unlock-sheet" role="dialog" aria-modal="true" aria-labelledby="unlock-title">
          <div class="sheet-grabber" />
          <button class="icon-button unlock-sheet__close" type="button" aria-label="Close" @click="emit('close')">
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

          <template v-else-if="status === 'pending' || status === 'failed' || status === 'cancelled'">
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
              <li v-if="purchasable"><Check :size="17" /> Secure checkout through PayPal</li>
            </ul>
            <div v-if="error" class="inline-error"><CircleAlert :size="18" /><span>{{ error }} <a href="mailto:support@iseedrama.com?subject=Payment%20support">Contact support</a></span></div>
            <div class="paypal-slot">
              <template v-if="purchasable && paypalAvailable">
                <div v-if="!sdkFailed" ref="paypalContainer" class="paypal-buttons" aria-label="PayPal checkout" />
                <button v-if="sdkFailed" class="button button--primary button--wide" type="button" @click="checkout">Continue to PayPal</button>
              </template>
              <div v-else-if="!purchasable" class="payment-unavailable" role="status"><CircleAlert :size="19" /><div><strong>Purchase unavailable</strong><span>A checkout price has not been set for this series.</span></div></div>
              <div v-else class="payment-unavailable" role="status"><Clock3 :size="19" /><div><strong>Checkout coming soon</strong><span>PayPal payments are not available yet.</span></div></div>
            </div>
            <p class="legal-copy">By continuing, you agree to our <NuxtLink to="/terms">Terms of Service</NuxtLink> and refund terms. Final access is granted after server confirmation.</p>
          </template>

          <div v-else-if="status === 'processing'" class="payment-state">
            <LoaderCircle class="spin" :size="34" />
            <h2>Payment processing</h2>
            <p>PayPal approved your payment. We’re waiting for secure server confirmation.</p>
            <span class="payment-state__hint">Keep this window open</span>
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
