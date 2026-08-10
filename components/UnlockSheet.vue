<script setup lang="ts">
import { Check, CircleAlert, LoaderCircle, ShieldCheck, X } from 'lucide-vue-next';
import { useUserAuth } from '~/composables/useUserAuth';
import type { OrderStatus, Series } from '~/types/content';

const props = defineProps<{ series: Series; open: boolean }>();
const emit = defineEmits<{ close: []; unlocked: [] }>();
const api = useContentApi();
const { formatPrice } = useFormatters();
const route = useRoute();
const { isAuthenticated } = useUserAuth();
const status = ref<OrderStatus>('pending');
const error = ref('');

watch(() => props.open, (isOpen) => {
  if (isOpen) {
    status.value = 'pending';
    error.value = '';
  }
});

const checkout = async () => {
  if (!isAuthenticated.value) {
    emit('close');
    await navigateTo({ path: '/login', query: { redirect: route.fullPath } });
    return;
  }

  status.value = 'processing';
  error.value = '';
  try {
    const order = await api.createOrder(props.series.id);
    if (!order.approvalUrl) throw new Error('PayPal approval URL missing');
    window.location.assign(order.approvalUrl);
  } catch {
    status.value = 'failed';
    error.value = 'Checkout could not be loaded. Check your connection and try again.';
  }
};
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

          <template v-else-if="status === 'pending' || status === 'failed'">
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
            <div id="paypal-button-container" class="paypal-slot">
              <button class="paypal-demo-button" type="button" @click="checkout">
                <span class="paypal-word">Pay</span><span class="paypal-word paypal-word--blue">Pal</span>
                <span>Continue securely</span>
              </button>
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
