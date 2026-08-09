<script setup lang="ts">
import { Clock3, LockKeyhole, Play } from 'lucide-vue-next';

const api = useContentApi();
const activeTab = ref('Continue watching');
const { data, status, error, refresh } = await useAsyncData('library', () => api.getLibrary());
</script>

<template>
  <div class="content-width page-top">
    <AppHeader compact />
    <header class="page-title"><span class="eyebrow">YOUR STORIES</span><h1>Library</h1></header>
    <div class="library-tabs"><button v-for="tab in ['Continue watching', 'Purchased']" :key="tab" type="button" :class="{ 'is-active': activeTab === tab }" @click="activeTab = tab">{{ tab }}</button></div>
    <PageSkeleton v-if="status === 'pending'" />
    <EmptyState v-else-if="error" title="Library unavailable" action="Try again" @action="refresh" />
    <template v-else-if="data">
      <div v-if="activeTab === 'Continue watching'" class="library-list">
        <NuxtLink v-for="series in data.continueWatching" :key="series.id" class="library-item" :to="`/watch/${series.slug}/${series.currentEpisode}`">
          <div class="library-item__image"><img :src="series.coverUrl" alt="" /><span><Play :size="17" fill="currentColor" /></span></div>
          <div class="library-item__body"><span class="library-item__eyebrow"><Clock3 :size="13" /> EP {{ series.currentEpisode }} of {{ series.episodeCount }}</span><h2>{{ series.title }}</h2><p>{{ series.tagline }}</p><div class="progress-track"><span :style="{ width: `${series.progress}%` }" /></div><small>{{ series.progress }}% watched</small></div>
        </NuxtLink>
      </div>
      <div v-else class="poster-grid"><SeriesCard v-for="series in data.purchased" :key="series.id" :series="series" /></div>
      <div v-if="activeTab === 'Purchased' && !data.purchased.length" class="library-lock"><LockKeyhole :size="24" /><h2>No purchases on this device</h2><p>Restore a past order from Profile or explore a new series.</p></div>
    </template>
  </div>
</template>
