<script setup lang="ts">
import { ChevronRight, CircleHelp, Clock3, FileText, Globe2, History, Mail, ReceiptText, RotateCcw, Shield, ShoppingBag } from 'lucide-vue-next';

const api = useContentApi();
const lookup = ref('');
const restoring = ref(false);
const restoreMessage = ref('');

const restore = async () => {
  if (!lookup.value.trim()) return;
  restoring.value = true;
  restoreMessage.value = '';
  try {
    const result = await api.restoreOrder(lookup.value.trim());
    restoreMessage.value = result.restored ? `${result.restored} purchase restored to this device.` : 'No verified purchases found.';
  } catch { restoreMessage.value = 'We could not verify that order. Check the details and try again.'; }
  finally { restoring.value = false; }
};

const menuGroups = [
  [{ label: 'My purchases', icon: ShoppingBag }, { label: 'Orders & payments', icon: ReceiptText }, { label: 'Watch history', icon: History }],
  [{ label: 'Language', value: 'English', icon: Globe2 }, { label: 'Privacy', icon: Shield }, { label: 'Terms & refund policy', icon: FileText }, { label: 'Help center', icon: CircleHelp }],
];
</script>

<template>
  <div class="content-width page-top profile-page">
    <AppHeader compact />
    <header class="profile-identity"><span class="profile-avatar">G</span><div><span class="eyebrow">GUEST VIEWER</span><h1>Your profile</h1><p>Purchases stay connected to this device.</p></div></header>
    <section class="restore-panel"><div class="restore-panel__title"><span><RotateCcw :size="19" /></span><div><h2>Restore a purchase</h2><p>Use your PayPal email or ReelNova order number.</p></div></div><label class="restore-input"><Mail :size="17" /><input v-model="lookup" type="text" placeholder="Email or RN-2026-..." @keyup.enter="restore" /></label><button class="button button--primary button--wide" type="button" :disabled="!lookup.trim() || restoring" @click="restore">{{ restoring ? 'Checking purchase…' : 'Restore purchase' }}</button><p v-if="restoreMessage" class="restore-message">{{ restoreMessage }}</p></section>
    <section v-for="(group, index) in menuGroups" :key="index" class="settings-list"><button v-for="item in group" :key="item.label" type="button"><span class="settings-list__icon"><component :is="item.icon" :size="19" /></span><strong>{{ item.label }}</strong><span v-if="item.value" class="settings-list__value">{{ item.value }}</span><ChevronRight :size="18" /></button></section>
    <div class="profile-meta"><Clock3 :size="15" /><span>Visitor ID: rn_7f31••••9da</span></div>
  </div>
</template>
