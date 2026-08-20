<script setup lang="ts">
import { Play } from 'lucide-vue-next';
import type { Series } from '~/types/content';

const props = defineProps<{ series: Series; rank?: number; horizontal?: boolean }>();
const { formatViews } = useFormatters();

const badgeClass = computed(() => `badge--${props.series.badge.toLowerCase()}`);
const fallbackCoverUrl = '/posters/vows-vengeance.jpg';

const useFallbackCover = (event: Event) => {
  const image = event.currentTarget as HTMLImageElement;
  if (image.dataset.fallbackApplied) return;
  image.dataset.fallbackApplied = 'true';
  image.src = fallbackCoverUrl;
};
</script>

<template>
  <NuxtLink
    class="series-card"
    :class="{ 'series-card--horizontal': horizontal }"
    :to="`/series/${series.slug}`"
    :aria-label="`${series.title}, ${formatViews(series.views)} views`"
  >
    <div class="series-card__poster">
      <img :src="series.coverUrl || fallbackCoverUrl" :alt="`${series.title} poster`" loading="lazy" @error="useFallbackCover" />
      <span v-if="rank" class="series-card__rank">{{ rank }}</span>
      <span class="content-badge" :class="badgeClass">{{ series.badge }}</span>
      <span class="series-card__views"><Play :size="12" fill="currentColor" />{{ formatViews(series.views) }}</span>
      <span v-if="series.purchased" class="series-card__owned">Owned</span>
    </div>
    <div class="series-card__body">
      <h3>{{ series.title }}</h3>
      <p>{{ series.genres[0] }}</p>
      <div v-if="series.progress" class="progress-track" aria-label="Watch progress">
        <span :style="{ width: `${series.progress}%` }" />
      </div>
    </div>
  </NuxtLink>
</template>
