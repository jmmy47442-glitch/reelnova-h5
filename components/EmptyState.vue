<script setup lang="ts">
import { Clapperboard, RefreshCw } from 'lucide-vue-next';

withDefaults(defineProps<{ title?: string; message?: string; action?: string }>(), {
  title: 'Nothing here yet',
  message: 'Try a different filter or come back for the next release.',
  action: 'Reset filters',
});

const emit = defineEmits<{ action: [] }>();
</script>

<template>
  <div class="empty-state">
    <span class="empty-state__icon"><Clapperboard :size="28" /></span>
    <h2>{{ title }}</h2>
    <p>{{ message }}</p>
    <button class="button button--secondary" type="button" @click="emit('action')">
      <RefreshCw :size="17" /> {{ action }}
    </button>
  </div>
</template>
