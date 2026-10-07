<script setup lang="ts">
import { Clock3, LockKeyhole, Play } from 'lucide-vue-next';
import { usePageData } from '~/composables/usePageData';
import { useUserAuth } from '~/composables/useUserAuth';

defineProps<{ activeTab: string }>();
const emit = defineEmits<{ status: [value: string] }>();
const api = useContentApi();
const { session } = useUserAuth();
const libraryKey = `library-${session.value?.userId}`;
const { data, status, error, refresh } = usePageData(
  libraryKey,
  () => api.getLibrary(),
  { revalidateOnActivate: true },
);

watch(status, value => emit('status', value), { immediate: true });
defineExpose({ refresh });
</script>

<template>
  <PageSkeleton v-if="status === 'pending'" />
  <EmptyState v-else-if="error" title="Library unavailable" action="Try again" @action="refresh" />
  <template v-else-if="data">
    <div v-if="activeTab === 'Continue watching'" class="library-list">
      <NuxtLink v-for="series in data.continueWatching" :key="series.id" class="library-item" :to="`/watch/${series.slug}/${series.currentEpisode}`">
        <div class="library-item__image"><img :src="series.coverUrl" :alt="`${series.title} poster`" /><span><Play :size="17" fill="currentColor" /></span></div>
        <div class="library-item__body"><span class="library-item__eyebrow"><Clock3 :size="13" /> EP {{ series.currentEpisode }} of {{ series.episodeCount }}</span><h2>{{ series.title }}</h2><p>{{ series.tagline }}</p><div class="progress-track"><span :style="{ width: `${series.progress}%` }" /></div><small>{{ series.progress }}% watched</small></div>
      </NuxtLink>
      <div v-if="!data.continueWatching.length" class="library-lock"><Clock3 :size="24" /><h2>Nothing in progress</h2><p>Start a story and it will appear here.</p><NuxtLink class="guest-text-link" to="/explore">Explore stories</NuxtLink></div>
    </div>
    <div v-else class="poster-grid"><SeriesCard v-for="series in data.purchased" :key="series.id" :series="series" /></div>
    <div v-if="activeTab === 'Purchased' && !data.purchased.length" class="library-lock"><LockKeyhole :size="24" /><h2>No purchases yet</h2><p>Unlocked stories will stay ready to watch here.</p><NuxtLink class="guest-text-link" to="/explore">Explore stories</NuxtLink></div>
  </template>
</template>
