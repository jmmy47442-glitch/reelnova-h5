<script setup lang="ts">
import { ChevronRight } from 'lucide-vue-next';

defineProps<{ title: string; subtitle?: string; to?: string }>();
</script>

<template>
  <div class="section-heading">
    <div>
      <h2>{{ title }}</h2>
      <p v-if="subtitle">{{ subtitle }}</p>
    </div>
    <NuxtLink v-if="to" :to="to" class="text-link">
      See all <ChevronRight :size="16" />
    </NuxtLink>
  </div>
</template>
