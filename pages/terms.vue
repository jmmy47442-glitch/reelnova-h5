<script setup lang="ts">
import { ArrowLeft, ChevronDown, FileText, LogIn, Mail } from 'lucide-vue-next';
import { termsOfService } from '~/data/legal';

definePageMeta({ hideBottomNav: true });
const openTerm = ref(0);

useHead({
  title: 'Terms of Service - ReelNova',
  meta: [{ name: 'description', content: 'ReelNova Terms of Service, including purchases, account use, content access, refunds, and dispute resolution.' }],
});
</script>

<template>
  <div class="content-width page-top account-page">
    <header class="account-toolbar">
      <NuxtLink class="account-toolbar__back" to="/" aria-label="Back to ReelNova home"><ArrowLeft :size="21" /></NuxtLink>
      <span>LEGAL</span>
      <span class="account-toolbar__actions"><NuxtLink class="account-toolbar__help" to="/login" aria-label="Sign in"><LogIn :size="19" /></NuxtLink></span>
    </header>

    <header class="account-heading">
      <span class="account-heading__icon"><FileText :size="22" /></span>
      <div><span class="eyebrow">POLICIES</span><h1>Terms of Service</h1><p>The rules for using ReelNova, purchasing digital access, and resolving issues.</p></div>
    </header>

    <main class="account-content">
      <aside class="policy-summary"><span><FileText :size="21" /></span><div><strong>Effective August 10, 2026</strong><p>These terms apply to the ReelNova website, player, accounts, and digital story passes.</p></div></aside>
      <div class="policy-list">
        <article v-for="(item, index) in termsOfService" :key="item.title" :class="{ 'is-open': openTerm === index }">
          <button type="button" :aria-expanded="openTerm === index" @click="openTerm = openTerm === index ? -1 : index"><span>{{ item.title }}</span><ChevronDown :size="18" /></button>
          <p v-if="openTerm === index">{{ item.body }}</p>
        </article>
      </div>
      <section class="refund-callout"><div><strong>Questions about these terms?</strong><p>Contact support before opening a payment or access dispute.</p></div><a class="button button--secondary" href="mailto:support@iseedrama.com?subject=Terms%20question">Email support</a></section>
      <p class="account-footnote"><Mail :size="14" /> Privacy questions: privacy@iseedrama.com</p>
    </main>
  </div>
</template>
