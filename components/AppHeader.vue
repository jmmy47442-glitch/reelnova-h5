<script setup lang="ts">
import { Globe2, RefreshCw, Search } from 'lucide-vue-next';

withDefaults(defineProps<{ compact?: boolean; refreshable?: boolean; refreshing?: boolean; pendingUpdates?: number }>(), {
  compact: false,
  refreshable: false,
  refreshing: false,
  pendingUpdates: 0,
});
defineEmits<{ refresh: [] }>();
</script>

<template>
  <header class="app-header" :class="{ 'app-header--compact': compact }">
    <NuxtLink class="wordmark" to="/" aria-label="ReelNova home">
      <span class="wordmark__mark">R</span>
      <span>REELNOVA</span>
    </NuxtLink>
    <div class="app-header__actions">
      <button v-if="refreshable && pendingUpdates > 0 && !refreshing" class="header-update-notice" type="button" aria-label="Refresh updated page data" @click="$emit('refresh')">
        <RefreshCw :size="16" aria-hidden="true" /><span aria-live="polite">{{ pendingUpdates }} {{ pendingUpdates === 1 ? 'update' : 'updates' }} · Refresh</span>
      </button>
      <button
        v-if="refreshable && (pendingUpdates === 0 || refreshing)"
        class="icon-button"
        :class="{ 'is-spinning': refreshing }"
        type="button"
        :disabled="refreshing"
        aria-label="Refresh page data"
        @click="$emit('refresh')"
      >
        <RefreshCw :size="20" />
      </button>
      <NuxtLink class="icon-button" to="/explore" aria-label="Search">
        <Search :size="21" />
      </NuxtLink>
      <NuxtLink class="icon-button" to="/profile/language" aria-label="Language and region">
        <Globe2 :size="20" />
      </NuxtLink>
    </div>
  </header>
</template>
