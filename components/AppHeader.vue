<script setup lang="ts">
import { Globe2, Search } from 'lucide-vue-next';

defineProps<{ compact?: boolean }>();
</script>

<template>
  <header class="app-header" :class="{ 'app-header--compact': compact }">
    <NuxtLink class="wordmark" to="/" aria-label="ReelNova home">
      <span class="wordmark__mark">R</span>
      <span>REELNOVA</span>
    </NuxtLink>
    <div class="app-header__actions">
      <NuxtLink class="icon-button" to="/explore" aria-label="Search">
        <Search :size="21" />
      </NuxtLink>
      <button class="icon-button" type="button" aria-label="Language and region">
        <Globe2 :size="20" />
      </button>
    </div>
  </header>
</template>
