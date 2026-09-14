<script setup lang="ts">
import { RotateCcw } from 'lucide-vue-next';
import type { Order } from '~/types/content';

const props = defineProps<{ order: Order }>();
const emit = defineEmits<{ submitted: [status: NonNullable<Order['refundStatus']>] }>();
const api = useContentApi();
const dialog = ref<HTMLDialogElement>();
const reason = ref('');
const submitting = ref(false);
const error = ref('');
const status = computed(() => props.order.status === 'refunded' ? 'completed' : props.order.refundStatus || (props.order.status === 'refunding' ? 'processing' : undefined));
const canRequest = computed(() => props.order.status === 'paid' && props.order.amount > 0 && !status.value);
const labels = { pending: 'Refund requested', processing: 'Refund processing', completed: 'Refunded', failed: 'Refund needs review', rejected: 'Refund declined', cancelled: 'Refund cancelled' };
const supportUrl = computed(() => `mailto:support@iseedrama.com?subject=${encodeURIComponent(`Refund review: ${props.order.orderNo}`)}`);
const open = () => {
  reason.value = '';
  error.value = '';
  dialog.value?.showModal();
};
const close = () => { if (!submitting.value) dialog.value?.close(); };
const submit = async () => {
  if (submitting.value || !canRequest.value) return;
  if (reason.value.trim().length < 8 || reason.value.trim().length > 500) {
    error.value = 'Refund reason must be 8-500 characters.';
    return;
  }
  submitting.value = true;
  error.value = '';
  try {
    const result = await api.requestRefund(props.order.orderNo, reason.value.trim());
    emit('submitted', result.refundStatus);
    dialog.value?.close();
  } catch (cause: any) {
    error.value = cause?.data?.statusMessage || 'Your request could not be submitted. Please try again.';
  } finally { submitting.value = false; }
};
onDeactivated(() => dialog.value?.close());
</script>

<template>
  <button v-if="canRequest" class="button button--secondary purchase-refund-button" type="button" @click="open"><RotateCcw :size="16" /> Request refund</button>
  <span v-else-if="status" class="purchase-refund-status" role="status">
    {{ labels[status] }}
    <a v-if="['failed', 'rejected', 'cancelled'].includes(status)" :href="supportUrl">Contact support</a>
  </span>
  <Teleport to="body">
    <dialog ref="dialog" class="purchase-refund-dialog" :aria-labelledby="`refund-title-${order.orderNo}`" @cancel.prevent="close" @click="($event.target === dialog) && close()">
      <form @submit.prevent="submit">
        <h2 :id="`refund-title-${order.orderNo}`">Request refund</h2>
        <strong>{{ order.seriesTitle }}</strong>
        <p>{{ order.orderNo }} · {{ order.currency }} {{ order.amount.toFixed(2) }}</p>
        <p>Your request will be reviewed. Any approved refund returns to your original payment method.</p>
        <label :for="`refund-reason-${order.orderNo}`">Refund reason</label>
        <textarea :id="`refund-reason-${order.orderNo}`" v-model="reason" rows="4" maxlength="500" required :disabled="submitting" :aria-invalid="Boolean(error)" :aria-describedby="error ? `refund-error-${order.orderNo}` : undefined" />
        <p v-if="error" :id="`refund-error-${order.orderNo}`" class="purchase-refund-error" role="alert">{{ error }}</p>
        <div class="purchase-refund-dialog__actions">
          <button class="button button--secondary" type="button" :disabled="submitting" @click="close">Cancel</button>
          <button class="button button--primary" type="submit" :disabled="submitting"><RotateCcw :size="16" />{{ submitting ? 'Submitting...' : 'Submit request' }}</button>
        </div>
      </form>
    </dialog>
  </Teleport>
</template>

<style scoped>
.purchase-refund-button { color: var(--signal); }
.purchase-refund-status { display: flex; min-height: 44px; color: var(--text-muted); flex-direction: column; justify-content: center; gap: 4px; font-size: 12px; }
.purchase-refund-status a { color: var(--signal); text-decoration: underline; }
.purchase-refund-dialog { width: min(430px, calc(100% - 32px)); max-height: calc(100dvh - 32px); margin: auto; padding: 24px; overflow-y: auto; border: 1px solid var(--line); border-radius: 8px; background: var(--surface); color: var(--text); }
.purchase-refund-dialog::backdrop { background: rgb(0 0 0 / 65%); }
.purchase-refund-dialog h2 { margin-bottom: 18px; font-size: 22px; }
.purchase-refund-dialog strong, .purchase-refund-dialog p { overflow-wrap: anywhere; }
.purchase-refund-dialog p { margin-top: 8px; color: var(--text-muted); font-size: 13px; line-height: 1.6; }
.purchase-refund-dialog label { display: block; margin: 20px 0 8px; font-size: 14px; }
.purchase-refund-dialog textarea { width: 100%; padding: 12px; border: 1px solid var(--line); border-radius: 4px; background: var(--ink); color: var(--text); resize: vertical; font: inherit; font-size: 16px; }
.purchase-refund-dialog textarea:focus-visible { outline: 2px solid var(--mint); outline-offset: 2px; }
.purchase-refund-dialog .purchase-refund-error { color: var(--danger); }
.purchase-refund-dialog__actions { display: flex; margin-top: 20px; justify-content: flex-end; flex-wrap: wrap; gap: 8px; }
.purchase-refund-dialog__actions .button { min-height: 44px; font-size: 13px; }
</style>
