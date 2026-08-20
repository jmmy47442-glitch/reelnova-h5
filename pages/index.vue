<script setup lang="ts">
import { ChevronRight, Flame, Play } from 'lucide-vue-next';

const api = useContentApi();
const { formatViews } = useFormatters();
const activeTab = ref('Popular');
const { data, status, error, refresh } = await useAsyncData('home', () => api.getHome());

let scrollFrame: number | null = null;

const scrollToSection = (target: HTMLElement) => {
  if (scrollFrame !== null) cancelAnimationFrame(scrollFrame);

  const startY = window.scrollY;
  const targetY = target.getBoundingClientRect().top + startY - 56;
  const distance = targetY - startY;

  if (Math.abs(distance) < 2 || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    window.scrollTo(0, targetY);
    scrollFrame = null;
    return;
  }

  const startedAt = performance.now();
  const duration = 180;
  const tick = (now: number) => {
    const progress = Math.min((now - startedAt) / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3);
    window.scrollTo(0, startY + distance * eased);

    if (progress < 1) scrollFrame = requestAnimationFrame(tick);
    else scrollFrame = null;
  };

  scrollFrame = requestAnimationFrame(tick);
};

const selectTab = (tab: string) => {
  activeTab.value = tab;
  const map: Record<string, string> = { Popular: 'popular', New: 'new', Rankings: 'popular', Categories: 'romance' };
  const target = document.getElementById(map[tab]);
  if (target) scrollToSection(target);
};

onBeforeUnmount(() => {
  if (scrollFrame !== null) cancelAnimationFrame(scrollFrame);
});
</script>

<template>
  <div>
    <AppHeader />
    <div v-if="status === 'pending'" class="content-width"><PageSkeleton /></div>
    <div v-else-if="error" class="content-width page-state"><EmptyState title="We lost the signal" message="The latest shows could not be loaded." action="Try again" @action="refresh" /></div>
    <template v-else-if="data">
      <section class="featured-strip" :style="{ '--feature-image': `url(${data.featured.backdropUrl})` }">
        <div class="featured-strip__content content-width">
          <span class="live-label"><Flame :size="14" fill="currentColor" /> TRENDING #1 IN THE US</span>
          <h1>{{ data.featured.title }}</h1>
          <p>{{ data.featured.tagline }}</p>
          <div class="featured-strip__meta"><span>{{ data.featured.genres.join(' · ') }}</span><span>{{ formatViews(data.featured.views) }} plays</span></div>
          <NuxtLink class="button button--primary" :to="`/watch/${data.featured.slug}/1`"><Play :size="18" fill="currentColor" /> Watch free</NuxtLink>
        </div>
      </section>

      <div class="sticky-category-wrap">
        <nav class="category-tabs content-width" aria-label="Content categories">
          <button v-for="tab in data.tabs" :key="tab" type="button" :class="{ 'is-active': activeTab === tab }" @click="selectTab(tab)">{{ tab }}</button>
        </nav>
      </div>

      <div class="content-width home-sections">
        <div class="now-playing-line"><span><i /> Now playing</span><strong>2,840 viewers watching</strong></div>
        <section v-for="(section, sectionIndex) in data.sections" :id="section.id" :key="section.id" class="content-section">
          <SectionHeader :title="section.title" :subtitle="section.subtitle" :to="`/explore?section=${section.id}`" />
          <div class="poster-grid">
            <SeriesCard v-for="(series, index) in section.items" :key="series.id" :series="series" :rank="sectionIndex === 0 ? index + 1 : undefined" />
          </div>
          <NuxtLink v-if="sectionIndex === 0" class="section-inline-link" to="/explore">Explore every series <ChevronRight :size="17" /></NuxtLink>
        </section>
      </div>
    </template>
  </div>
</template>
