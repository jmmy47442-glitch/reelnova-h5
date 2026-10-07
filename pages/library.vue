<script setup lang="ts">
import { Bookmark, Check, Cloud, LockKeyhole, Play, ShoppingBag } from 'lucide-vue-next';
import { useUserAuth } from '~/composables/useUserAuth';

definePageMeta({ keepalive: true });
const { isAuthenticated } = useUserAuth();
const activeTab = ref('Continue watching');
const libraryStatus = ref('idle');
const authenticatedLibrary = ref<{ refresh: () => Promise<void> } | null>(null);
const tabs = ['Continue watching', 'Purchased'];

const guestCopy = computed(() => activeTab.value === 'Continue watching'
  ? {
      eyebrow: 'WATCH ACROSS DEVICES',
      title: 'Never lose your place.',
      message: 'Sign in to keep every episode, timestamp, and next-up story together.',
      action: 'Sign in to sync progress',
      icon: Play,
    }
  : {
      eyebrow: 'YOUR STORIES, KEPT SAFE',
      title: 'Unlock once. Watch anytime.',
      message: 'Sign in to see purchased stories and restore access on this device.',
      action: 'Sign in to view purchases',
      icon: ShoppingBag,
    });

const refresh = () => authenticatedLibrary.value?.refresh();
</script>

<template>
  <div class="content-width page-top library-page">
    <AppHeader compact :refreshable="isAuthenticated" :refreshing="libraryStatus === 'pending'" @refresh="refresh" />
    <header class="page-title"><span class="eyebrow">YOUR STORIES</span><h1>Library</h1></header>
    <div class="library-tabs" role="tablist" aria-label="Library views">
      <button v-for="tab in tabs" :id="`library-tab-${tab.replace(' ', '-').toLowerCase()}`" :key="tab" type="button" role="tab" aria-controls="library-panel" :aria-selected="activeTab === tab" :class="{ 'is-active': activeTab === tab }" @click="activeTab = tab">{{ tab }}</button>
    </div>

    <section v-if="isAuthenticated" id="library-panel" role="tabpanel" :aria-labelledby="`library-tab-${activeTab.replace(' ', '-').toLowerCase()}`">
      <AuthenticatedLibrary ref="authenticatedLibrary" :active-tab="activeTab" @status="libraryStatus = $event" />
    </section>

    <section v-else id="library-panel" class="guest-library" role="tabpanel" :aria-labelledby="`library-tab-${activeTab.replace(' ', '-').toLowerCase()}`">
      <div class="guest-library__art" aria-hidden="true">
        <div class="guest-library__poster guest-library__poster--left"><img src="/posters/hockey-deal.jpg" alt="" /></div>
        <div class="guest-library__poster guest-library__poster--center"><img src="/posters/heiress-returns.jpg" alt="" /><span><Play :size="18" fill="currentColor" /></span></div>
        <div class="guest-library__poster guest-library__poster--right"><img src="/posters/faking-forever.jpg" alt="" /></div>
        <span class="guest-library__saved"><Bookmark :size="14" fill="currentColor" /> Saved for you</span>
      </div>
      <div class="guest-library__copy">
        <span class="eyebrow"><component :is="guestCopy.icon" :size="13" /> {{ guestCopy.eyebrow }}</span>
        <h2>{{ guestCopy.title }}</h2>
        <p>{{ guestCopy.message }}</p>
      </div>
      <div class="guest-library__benefits" aria-label="Account benefits">
        <span><Check :size="15" /> Synced progress</span>
        <span><Cloud :size="15" /> Any device</span>
        <span><LockKeyhole :size="15" /> Purchases restored</span>
      </div>
      <NuxtLink class="button guest-primary-action" :to="{ path: '/login', query: { redirect: '/library' } }">
        {{ guestCopy.action }}
      </NuxtLink>
      <p class="guest-secondary-action">New to ReelNova? <NuxtLink :to="{ path: '/register', query: { redirect: '/library' } }">Create an account</NuxtLink></p>
    </section>
  </div>
</template>
