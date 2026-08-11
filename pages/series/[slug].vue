<script setup lang="ts">
import { ArrowLeft, ChevronDown, Clock3, Eye, LockKeyhole, Play, Share2, Star } from 'lucide-vue-next';

definePageMeta({ hideBottomNav: true });
const route = useRoute();
const api = useContentApi();
const { formatPrice, formatViews } = useFormatters();
const showFullDescription = ref(false);
const showUnlock = ref(false);
const locallyUnlocked = ref(false);
const { data: series, status, error, refresh } = await useAsyncData(`series-${route.params.slug}`, () => api.getSeries(String(route.params.slug)));

onMounted(async () => {
  const orderNo = String(route.query.orderNo || '');
  if (!orderNo || !['success', 'processing'].includes(String(route.query.payment))) return;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const order = await api.getOrder(orderNo).catch(() => null);
    if (order?.status === 'paid') { locallyUnlocked.value = true; await refresh(); break; }
    if (order && ['failed', 'cancelled', 'risk_review'].includes(order.status)) break;
    await new Promise((resolve) => window.setTimeout(resolve, 1500));
  }
});

const watchLabel = computed(() => {
  if (!series.value) return 'Watch free';
  if (series.value.purchased || locallyUnlocked.value) return series.value.progress ? 'Continue watching' : 'Start watching';
  return `Watch ${series.value.freeEpisodeCount} episodes free`;
});

const handleEpisode = (episodeNo: number, unlocked: boolean) => {
  if (!series.value) return;
  if (unlocked || locallyUnlocked.value) navigateTo(`/watch/${series.value.slug}/${episodeNo}`);
  else showUnlock.value = true;
};

const unlockComplete = () => {
  locallyUnlocked.value = true;
  showUnlock.value = false;
};
</script>

<template>
  <div class="detail-page">
    <div v-if="status === 'pending'" class="content-width"><PageSkeleton /></div>
    <EmptyState v-else-if="error || !series" title="Series not available" message="This title may have moved or is not available in your region." action="Go home" @action="navigateTo('/')" />
    <template v-else>
      <section class="detail-hero" :style="{ '--detail-backdrop': `url(${series.backdropUrl})` }">
        <div class="detail-toolbar"><button class="icon-button icon-button--glass" type="button" aria-label="Go back" @click="$router.back()"><ArrowLeft :size="21" /></button><button class="icon-button icon-button--glass" type="button" aria-label="Share"><Share2 :size="20" /></button></div>
        <div class="detail-hero__content content-width">
          <span class="content-badge" :class="`badge--${series.badge.toLowerCase()}`">{{ series.badge }}</span>
          <h1>{{ series.title }}</h1>
          <p class="detail-tagline">{{ series.tagline }}</p>
          <div class="detail-stats"><span><Star :size="15" fill="currentColor" /> {{ series.rating }}</span><span><Eye :size="15" /> {{ formatViews(series.views) }}</span><span>{{ series.updatedLabel }}</span></div>
          <div class="detail-actions"><NuxtLink class="button button--primary" :to="`/watch/${series.slug}/${series.currentEpisode || 1}`"><Play :size="18" fill="currentColor" />{{ watchLabel }}</NuxtLink><button v-if="!series.purchased && !locallyUnlocked" class="button button--ghost" type="button" @click="showUnlock = true"><LockKeyhole :size="17" />{{ formatPrice(series.price) }}</button></div>
        </div>
      </section>
      <div class="detail-content content-width">
        <div class="genre-row"><span v-for="genre in series.genres" :key="genre">{{ genre }}</span></div>
        <section class="detail-copy"><p :class="{ 'is-clamped': !showFullDescription }">{{ series.description }}</p><button type="button" @click="showFullDescription = !showFullDescription">{{ showFullDescription ? 'Show less' : 'Read more' }} <ChevronDown :size="15" :class="{ rotate: showFullDescription }" /></button><small>Cast: {{ series.cast.join(', ') }}</small></section>
        <section class="episode-section">
          <SectionHeader :title="`${series.episodeCount} episodes`" :subtitle="`${series.freeEpisodeCount} free · ${series.updatedLabel}`" />
          <div class="episode-grid">
            <button v-for="episode in series.episodes" :key="episode.id" type="button" :class="{ 'is-locked': !episode.isUnlocked && !locallyUnlocked }" @click="handleEpisode(episode.episodeNo, Boolean(episode.isUnlocked))">
              <strong>{{ episode.episodeNo }}</strong>
              <span v-if="episode.isUnlocked || locallyUnlocked"><Play :size="13" fill="currentColor" /></span><span v-else><LockKeyhole :size="13" /></span>
            </button>
          </div>
        </section>
        <section class="purchase-note"><LockKeyhole :size="19" /><div><h2>One pass. The whole story.</h2><p>Unlock episodes {{ series.freeEpisodeCount + 1 }}–{{ series.episodeCount }} and future updates for {{ formatPrice(series.price) }} USD.</p></div></section>
      </div>
      <UnlockSheet :series="series" :open="showUnlock" @close="showUnlock = false" @unlocked="unlockComplete" />
    </template>
  </div>
</template>
