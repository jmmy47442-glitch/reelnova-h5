<script setup lang="ts">
import { Check, CircleAlert, Clock3, LoaderCircle, ShieldCheck, X } from 'lucide-vue-next';
import { useUserAuth } from '~/composables/useUserAuth';
import type { OrderStatus, Series } from '~/types/content';

const props = defineProps<{ series: Series; open: boolean }>();
const emit = defineEmits<{ close: []; unlocked: [] }>();
const api = useContentApi();
const { formatPrice } = useFormatters();
const route = useRoute();
const { isAuthenticated } = useUserAuth();
const runtime = useRuntimeConfig();
const status = ref<OrderStatus>('pending');
const error = ref('');
const paypalContainer = ref<HTMLElement | null>(null);
const paypalRendered = ref(false);
const sdkFailed = ref(false);
const checkoutKey = ref('');
const paypalAvailable = computed(() => Boolean(runtime.public.paypalClientId));

const paypalWindow = () => (window as any);

const loadPayPalSdk = async () => {
  if (paypalWindow().paypal) return paypalWindow().paypal;
  const clientId = String(runtime.public.paypalClientId || '');
  if (!clientId) return undefined;
  await new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>('script[data-reelnova-paypal]');
    if (existing) { existing.addEventListener('load', () => resolve(), { once: true }); existing.addEventListener('error', () => reject(new Error('PayPal SDK failed')), { once: true }); return; }
    const script = document.createElement('script');
    script.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(clientId)}&currency=USD&intent=capture&components=buttons`;
    script.async = true;
    script.dataset.reelnovaPaypal = 'true';
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('PayPal SDK failed'));
    document.head.appendChild(script);
  });
  return paypalWindow().paypal;
};

const completePayment = async (paypalOrderId: string) => {
  status.value = 'processing';
  await api.capturePayPalOrder(paypalOrderId);
  status.value = 'paid';
  window.setTimeout(() => emit('unlocked'), 900);
};

const renderPayPal = async () => {
  if (!props.open || !isAuthenticated.value || !paypalAvailable.value || paypalRendered.value || !paypalContainer.value) return;
  try {
    const paypal = await loadPayPalSdk();
    if (!paypal || !paypalContainer.value) return;
    paypalRendered.value = true;
    await paypal.Buttons({
      style: { layout: 'vertical', color: 'gold', shape: 'rect', label: 'paypal', height: 48 },
      createOrder: async () => {
        checkoutKey.value ||= crypto.randomUUID();
        const order = await api.createOrder(props.series.id, checkoutKey.value);
        if (order.status === 'paid') { status.value = 'paid'; window.setTimeout(() => emit('unlocked'), 500); return order.paypalOrderId || ''; }
        if (!order.paypalOrderId) throw new Error('PayPal order missing');
        return order.paypalOrderId;
      },
      onApprove: async ({ orderID }: { orderID: string }) => completePayment(orderID),
      onCancel: () => { status.value = 'cancelled'; error.value = 'Payment was cancelled. Your order is saved and can be resumed.'; },
      onError: () => { status.value = 'failed'; error.value = 'PayPal could not complete checkout. Try again or contact support.'; },
    }).render(paypalContainer.value);
  } catch {
    paypalRendered.value = false;
    sdkFailed.value = true;
    error.value = 'PayPal buttons could not be loaded. Continue with secure PayPal checkout below.';
  }
};

watch(() => props.open, (isOpen) => {
  if (isOpen) {
    status.value = 'pending';
    error.value = '';
    checkoutKey.value = '';
    paypalRendered.value = false;
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
  if (!paypalAvailable.value) {
    status.value = 'failed';
    error.value = 'Checkout is not available yet.';
    return;
  }

  status.value = 'processing';
  error.value = '';
  try {
    checkoutKey.value ||= crypto.randomUUID();
    const order = await api.createOrder(props.series.id, checkoutKey.value);
    if (order.status === 'paid') { status.value = 'paid'; emit('unlocked'); return; }
    if (!order.approvalUrl) throw new Error('PayPal approval URL missing');
    window.location.assign(order.approvalUrl);
  } catch (reason: unknown) {
    status.value = 'failed';
    const statusCode = (reason as { statusCode?: number; response?: { status?: number } }).statusCode
      || (reason as { response?: { status?: number } }).response?.status;
    error.value = statusCode === 503
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
                <strong>{{ formatPrice(series.price) }}</strong>
                <span> USD · one-time</span>
              </div>
              <span class="save-pill" v-if="series.originalPrice">Save {{ Math.round((1 - series.price / series.originalPrice) * 100) }}%</span>
            </div>
            <ul class="unlock-list">
              <li><Check :size="17" /> Episodes {{ series.freeEpisodeCount + 1 }}–{{ series.episodeCount }}</li>
              <li><Check :size="17" /> Keep access on restored devices</li>
              <li><Check :size="17" /> Secure checkout through PayPal</li>
            </ul>
            <div v-if="error" class="inline-error"><CircleAlert :size="18" />{{ error }}</div>
            <div class="paypal-slot">
              <div v-if="paypalAvailable && !sdkFailed" ref="paypalContainer" aria-label="PayPal checkout" />
              <button v-else-if="paypalAvailable" class="button button--primary button--wide" type="button" @click="checkout">Continue to PayPal</button>
              <div v-else class="payment-unavailable" role="status"><Clock3 :size="19" /><div><strong>Checkout coming soon</strong><span>PayPal payments are not available yet.</span></div></div>
            </div>
            <p class="legal-copy">By continuing, you agree to our Terms and Refund Policy. Final access is granted after server confirmation.</p>
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
