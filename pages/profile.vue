<script setup lang="ts">
import { ChevronRight, CircleHelp, Clock3, FileText, Globe2, History, LockKeyhole, LogIn, LogOut, Moon, ReceiptText, Shield, ShoppingBag, Sun, UserRound } from 'lucide-vue-next';
import { useUserAuth } from '~/composables/useUserAuth';
import { useAccountSettings } from '~/composables/useAccountSettings';
import { useColorTheme } from '~/composables/useColorTheme';
import { useLocale } from '~/composables/useLocale';

definePageMeta({ keepalive: true });
const { session, isAuthenticated, logout } = useUserAuth();
const { settings } = useAccountSettings();
const { t } = useLocale();
const { isLight, toggleTheme } = useColorTheme();
const route = useRoute();

const languageNames = { en: 'English', es: 'Espanol', pt: 'Portugues', fr: 'Francais', de: 'Deutsch' } as const;
const menuGroups = computed(() => [
  [{ label: t('profile.purchases'), to: '/profile/purchases', icon: ShoppingBag }, { label: t('profile.orders'), to: '/profile/orders', icon: ReceiptText }, { label: t('profile.history'), to: '/profile/history', icon: History }],
  [{ label: t('profile.language'), to: '/profile/language', value: languageNames[settings.value.language], icon: Globe2 }, { label: t('profile.privacy'), to: '/profile/privacy', icon: Shield }, { label: t('profile.terms'), to: '/profile/terms', icon: FileText }, { label: t('profile.help'), to: '/profile/help', icon: CircleHelp }],
]);
const guestFeatures = [
  { label: 'Watch history', detail: 'Continue from the exact moment you stopped', to: '/profile/history', icon: History },
  { label: 'Purchases & access', detail: 'Keep unlocked stories on every device', to: '/profile/purchases', icon: ShoppingBag },
  { label: 'Account settings', detail: 'Manage language, privacy, and support', to: '/profile/privacy', icon: Shield },
];

const initials = computed(() => session.value?.name.trim().charAt(0).toUpperCase() || 'R');
const signInTarget = (redirect = '/profile') => ({ path: '/login', query: { redirect } });

const signOut = async () => {
  await logout();
  await navigateTo('/login');
};
</script>

<template>
  <NuxtPage v-if="route.path !== '/profile'" />
  <div v-else class="content-width page-top profile-page">
    <AppHeader compact />

    <template v-if="isAuthenticated">
      <header class="profile-identity"><span class="profile-avatar">{{ initials }}</span><div><span class="eyebrow">{{ t('profile.member') }}</span><h1>{{ session?.name || t('profile.title') }}</h1><p>{{ session?.email || t('profile.unavailable') }}</p></div></header>
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
    </template>

    <template v-else>
      <header class="guest-profile-hero">
        <span class="guest-profile-hero__avatar"><UserRound :size="29" /></span>
        <div class="guest-profile-hero__status"><span class="guest-status-dot" /> Guest mode</div>
        <h1>Make every episode yours.</h1>
        <p>You can browse and watch free episodes as a guest. Sign in when you want your stories to follow you.</p>
        <NuxtLink class="button guest-primary-action" :to="signInTarget()"><LogIn :size="18" /> Sign in to ReelNova</NuxtLink>
        <p class="guest-secondary-action">New here? <NuxtLink :to="{ path: '/register', query: { redirect: '/profile' } }">Create an account</NuxtLink></p>
      </header>

      <section class="guest-profile-features" aria-labelledby="guest-profile-features-title">
        <div class="guest-section-heading"><span class="eyebrow">WITH AN ACCOUNT</span><h2 id="guest-profile-features-title">Pick up where you left off</h2></div>
        <NuxtLink v-for="feature in guestFeatures" :key="feature.label" class="guest-feature-row" :to="signInTarget(feature.to)">
          <span class="settings-list__icon"><component :is="feature.icon" :size="19" /></span>
          <span><strong>{{ feature.label }}</strong><small>{{ feature.detail }}</small></span>
          <LockKeyhole :size="16" aria-label="Sign in required" />
        </NuxtLink>
      </section>

      <section class="settings-list guest-device-settings">
        <div class="guest-section-heading"><span class="eyebrow">ON THIS DEVICE</span></div>
        <button class="theme-setting" type="button" role="switch" :aria-checked="isLight" :aria-label="`Appearance: ${isLight ? 'Light' : 'Dark'}`" @click="toggleTheme">
          <span class="settings-list__icon"><Sun v-if="isLight" :size="19" /><Moon v-else :size="19" /></span>
          <strong>Appearance</strong>
          <span class="settings-list__value">{{ isLight ? 'Light' : 'Dark' }}</span>
          <span class="settings-list__switch" aria-hidden="true"><i /></span>
        </button>
        <NuxtLink to="/terms"><span class="settings-list__icon"><FileText :size="19" /></span><strong>Terms of Service</strong><ChevronRight :size="18" /></NuxtLink>
      </section>
    </template>
  </div>
</template>
