<script setup lang="ts">
import { ArrowLeft, Play, Sparkles, TrendingUp } from 'lucide-vue-next';
import type { HomeResponse, Series } from '~/types/content';
import { usePageData } from '~/composables/usePageData';

const route = useRoute();
const sectionId = String(route.params.id || '');
const api = useContentApi();
const activeGenre = ref('All');
const { data, status, error, refresh } = usePageData<{ title: string; subtitle: string; items: Series[]; genres: string[] }>(
  `section-${sectionId}`,
  async () => {
    if (sectionId === 'new' || sectionId === 'popular') {
      const catalog = await api.getExplore({ sort: sectionId === 'new' ? 'Newest' : 'Popular' });
      const fallback = sectionId === 'new'
        ? { title: 'Fresh episodes', subtitle: 'New stories and the latest updates, ready for your next binge.' }
        : { title: 'Popular now', subtitle: 'The most-watched stories on ReelNova, ranked by viewers.' };
      return { ...fallback, items: catalog.items, genres: catalog.genres };
    }
    const home: HomeResponse = await api.getHome();
    const homeSection = home.sections.find((item) => item.id === sectionId);
    if (homeSection) {
      return {
        title: homeSection.title,
        subtitle: homeSection.subtitle,
        items: homeSection.items,
        genres: [...new Set(homeSection.items.flatMap((item) => item.genres))],
      };
    }
    throw createError({ statusCode: 404, statusMessage: 'Section not found' });
  },
  { revalidateOnMount: true, revalidateOnActivate: true },
);
const isNew = computed(() => sectionId === 'new');
const isPopular = computed(() => sectionId === 'popular');
const eyebrow = computed(() => isNew.value ? 'JUST ADDED' : isPopular.value ? 'THE TOP STORIES' : 'CURATED FOR YOU');
const sectionIcon = computed(() => isNew.value ? Sparkles : TrendingUp);
const sortLabel = computed(() => isNew.value ? 'Newest' : isPopular.value ? 'Popular' : 'Featured');
const genres = computed(() => ['All', ...(data.value?.genres || [])]);
const items = computed(() => {
  const allItems = data.value?.items || [];
  return activeGenre.value === 'All'
    ? allItems
    : allItems.filter((item) => item.genres.some((genre) => genre.toLowerCase() === activeGenre.value.toLowerCase()));
});
const lead = computed(() => items.value[0]);
</script>

<template>
  <div class="content-width section-page">
    <AppHeader compact />
    <NuxtLink class="section-page__back" to="/" aria-label="Back to home"><ArrowLeft :size="18" /> <span>Home</span></NuxtLink>

    <div v-if="status === 'pending'" class="section-page__loading"><PageSkeleton /></div>
    <EmptyState v-else-if="error" title="Could not load stories" message="The list is unavailable right now." action="Try again" @action="refresh" />
    <template v-else-if="data">
      <header class="section-page__heading">
        <div class="section-page__eyebrow"><component :is="sectionIcon" :size="14" /> {{ eyebrow }}</div>
        <h1>{{ data.title }}</h1>
        <p>{{ data.subtitle }}</p>
      </header>

      <NuxtLink v-if="lead" class="section-lead" :to="`/series/${lead.slug}`">
        <img :src="lead.backdropUrl || lead.coverUrl" :alt="`${lead.title} featured artwork`" />
        <span class="section-lead__shade" />
        <span class="section-lead__rank">{{ isPopular ? '01' : isNew ? 'NEW' : 'FEATURED' }}</span>
        <span class="section-lead__copy">
          <span class="section-lead__label">{{ isPopular ? 'MOST WATCHED' : isNew ? 'LATEST STORY' : 'EDITOR’S PICK' }}</span>
          <strong>{{ lead.title }}</strong>
          <small>{{ lead.genres.slice(0, 2).join(' · ') }} <span v-if="lead.episodeCount"> · {{ lead.episodeCount }} episodes</span></small>
          <span class="section-lead__play"><Play :size="15" fill="currentColor" /> View story</span>
        </span>
      </NuxtLink>

      <div class="section-page__toolbar">
        <div><strong>{{ items.length }} stories</strong><span>Find your next favorite</span></div>
        <span class="section-page__sort"><component :is="sectionIcon" :size="14" /> {{ sortLabel }}</span>
      </div>
      <nav class="chip-row section-page__genres" aria-label="Filter by genre">
        <button v-for="genre in genres" :key="genre" type="button" :aria-pressed="activeGenre === genre" :class="{ 'is-active': activeGenre === genre }" @click="activeGenre = genre">{{ genre }}</button>
      </nav>
      <EmptyState v-if="!items.length" title="No stories in this genre" message="Try another category to keep browsing." />
      <div v-else class="poster-grid explore-grid section-page__grid">
        <SeriesCard v-for="(series, index) in items" :key="series.id" :series="series" :section-id="sectionId" :rank="sectionId === 'popular' ? index + 1 : undefined" />
      </div>
    </template>
  </div>
</template>
