<script setup lang="ts">
import { ChevronRight, CircleHelp, Clock3, FileText, Globe2, History, LogIn, LogOut, Mail, ReceiptText, RotateCcw, Shield, ShoppingBag } from 'lucide-vue-next';
import { useUserAuth } from '~/composables/useUserAuth';

const api = useContentApi();
const { session, isAuthenticated, logout } = useUserAuth();
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

const initials = computed(() => session.value?.name.trim().charAt(0).toUpperCase() || 'G');

const signOut = async () => {
  await logout();
  await navigateTo('/login');
};
</script>

<template>
  <div class="content-width page-top profile-page">
    <AppHeader compact />
    <header class="profile-identity"><span class="profile-avatar">{{ initials }}</span><div><span class="eyebrow">{{ isAuthenticated ? 'REELNOVA MEMBER' : 'GUEST PREVIEW' }}</span><h1>{{ session?.name || 'Your profile' }}</h1><p>{{ session?.email || 'Free episodes are available on this device.' }}</p></div></header>
    <NuxtLink v-if="!isAuthenticated" class="profile-account-link" to="/register"><span><LogIn :size="18" /></span><div><strong>Create a free account</strong><small>Keep purchases and progress across devices.</small></div><ChevronRight :size="18" /></NuxtLink>
    <section class="restore-panel"><div class="restore-panel__title"><span><RotateCcw :size="19" /></span><div><h2>Restore a purchase</h2><p>Use your PayPal email or ReelNova order number.</p></div></div><label class="restore-input"><Mail :size="17" /><input v-model="lookup" type="text" placeholder="Email or RN-2026-..." @keyup.enter="restore" /></label><button class="button button--primary button--wide" type="button" :disabled="!lookup.trim() || restoring" @click="restore">{{ restoring ? 'Checking purchase…' : 'Restore purchase' }}</button><p v-if="restoreMessage" class="restore-message">{{ restoreMessage }}</p></section>
    <section v-for="(group, index) in menuGroups" :key="index" class="settings-list"><button v-for="item in group" :key="item.label" type="button"><span class="settings-list__icon"><component :is="item.icon" :size="19" /></span><strong>{{ item.label }}</strong><span v-if="item.value" class="settings-list__value">{{ item.value }}</span><ChevronRight :size="18" /></button></section>
    <section v-if="isAuthenticated" class="settings-list"><button class="profile-signout" type="button" @click="signOut"><span class="settings-list__icon"><LogOut :size="19" /></span><strong>Sign out</strong><ChevronRight :size="18" /></button></section>
    <div class="profile-meta"><Clock3 :size="15" /><span>{{ isAuthenticated ? 'Account and watch activity are synced' : 'Guest activity stays on this device' }}</span></div>
  </div>
</template>
