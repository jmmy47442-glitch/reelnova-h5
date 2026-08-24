<script setup lang="ts">
import { ChevronRight, CircleHelp, Clock3, FileText, Globe2, History, LogOut, Mail, Moon, ReceiptText, RotateCcw, Shield, ShoppingBag, Sun } from 'lucide-vue-next';
import { useUserAuth } from '~/composables/useUserAuth';
import { useAccountSettings } from '~/composables/useAccountSettings';
import { useColorTheme } from '~/composables/useColorTheme';
import { useLocale } from '~/composables/useLocale';
import { useAnalytics } from '~/composables/useAnalytics';

definePageMeta({ keepalive: true });
const api = useContentApi();
const { track } = useAnalytics();
const { session, logout } = useUserAuth();
const { settings } = useAccountSettings();
const { t } = useLocale();
const { isLight, toggleTheme } = useColorTheme();
const route = useRoute();
const lookup = ref('');
const restoring = ref(false);
const restoreMessage = ref('');

const restore = async () => {
  if (!lookup.value.trim()) return;
  void track('restore_purchase', { properties: { lookupType: lookup.value.includes('@') ? 'email' : 'order' } });
  restoring.value = true;
  restoreMessage.value = '';
  try {
    const result = await api.restoreOrder(lookup.value.trim());
    restoreMessage.value = result.restored ? `${result.restored} purchase restored to this device.` : 'No verified purchases found.';
  } catch { restoreMessage.value = 'We could not verify that order. Check the details and try again.'; }
  finally { restoring.value = false; }
};

const languageNames = { en: 'English', es: 'Espanol', pt: 'Portugues', fr: 'Francais', de: 'Deutsch' } as const;
const menuGroups = computed(() => [
  [{ label: t('profile.purchases'), to: '/profile/purchases', icon: ShoppingBag }, { label: t('profile.orders'), to: '/profile/orders', icon: ReceiptText }, { label: t('profile.history'), to: '/profile/history', icon: History }],
  [{ label: t('profile.language'), to: '/profile/language', value: languageNames[settings.value.language], icon: Globe2 }, { label: t('profile.privacy'), to: '/profile/privacy', icon: Shield }, { label: t('profile.terms'), to: '/profile/terms', icon: FileText }, { label: t('profile.help'), to: '/profile/help', icon: CircleHelp }],
]);

const initials = computed(() => session.value?.name.trim().charAt(0).toUpperCase() || 'R');

const signOut = async () => {
  await logout();
  await navigateTo('/login');
};
</script>

<template>
  <NuxtPage v-if="route.path !== '/profile'" />
  <div v-else class="content-width page-top profile-page">
    <AppHeader compact />
    <header class="profile-identity"><span class="profile-avatar">{{ initials }}</span><div><span class="eyebrow">{{ t('profile.member') }}</span><h1>{{ session?.name || t('profile.title') }}</h1><p>{{ session?.email || t('profile.unavailable') }}</p></div></header>
    <section class="restore-panel"><div class="restore-panel__title"><span><RotateCcw :size="19" /></span><div><h2>{{ t('profile.restore') }}</h2><p>{{ t('profile.restoreHelp') }}</p></div></div><label class="restore-input"><Mail :size="17" /><input v-model="lookup" type="text" placeholder="Email or RN-2026-..." @keyup.enter="restore" /></label><button class="button button--primary button--wide" type="button" :disabled="!lookup.trim() || restoring" @click="restore">{{ restoring ? t('profile.checking') : t('profile.restoreAction') }}</button><p v-if="restoreMessage" class="restore-message">{{ restoreMessage }}</p></section>
    <section v-for="(group, index) in menuGroups" :key="index" class="settings-list">
      <button
        v-if="index === 1"
        class="theme-setting"
        type="button"
        role="switch"
        :aria-checked="isLight"
        :aria-label="`${t('profile.appearance')}: ${isLight ? t('profile.light') : t('profile.dark')}`"
        @click="toggleTheme"
      >
        <span class="settings-list__icon"><Sun v-if="isLight" :size="19" /><Moon v-else :size="19" /></span>
        <strong>{{ t('profile.appearance') }}</strong>
        <span class="settings-list__value">{{ isLight ? t('profile.light') : t('profile.dark') }}</span>
        <span class="settings-list__switch" aria-hidden="true"><i /></span>
      </button>
      <NuxtLink v-for="item in group" :key="item.label" :to="item.to"><span class="settings-list__icon"><component :is="item.icon" :size="19" /></span><strong>{{ item.label }}</strong><span v-if="item.value" class="settings-list__value">{{ item.value }}</span><ChevronRight :size="18" /></NuxtLink>
    </section>
    <section class="settings-list"><button class="profile-signout" type="button" @click="signOut"><span class="settings-list__icon"><LogOut :size="19" /></span><strong>{{ t('profile.signout') }}</strong><ChevronRight :size="18" /></button></section>
    <div class="profile-meta"><Clock3 :size="15" /><span>{{ t('profile.synced') }}</span></div>
  </div>
</template>
