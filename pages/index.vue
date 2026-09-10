<script setup lang="ts">
import { ChevronRight, Flame, Heart, Play, Search, Shield, Sparkles, Trophy, UsersRound, WandSparkles } from 'lucide-vue-next';
import type { Component } from 'vue';
import { useAnalytics } from '~/composables/useAnalytics';
import { usePageData } from '~/composables/usePageData';

definePageMeta({ keepalive: true });
const api = useContentApi();
const { formatViews } = useFormatters();
const activeTab = ref('Popular');
const { data, status, error, refresh } = usePageData('home', () => api.getHome());
const { track } = useAnalytics();
const featuredTracked = ref(false);
const pendingUpdates = ref(0);
const router = useRouter();
const primaryTabRoutes = new Set(['/', '/explore', '/library', '/profile']);
const selectedGenre = ref('All');

const curatedCategoryDefinitions: { name: string; description: string; icon: Component; accent: string }[] = [
  { name: 'Romance', description: 'Slow burns & second chances', icon: Heart, accent: '#ff3d79' },
  { name: 'Revenge', description: 'Comebacks with consequences', icon: Shield, accent: '#f5c967' },
  { name: 'Billionaire', description: 'Power, secrets & desire', icon: Sparkles, accent: '#43dbc0' },
  { name: 'Mystery', description: 'Every clue changes everything', icon: Search, accent: '#668cff' },
  { name: 'Sports', description: 'Big plays, bigger feelings', icon: Trophy, accent: '#ff8b5c' },
  { name: 'Family', description: 'The ties that pull tight', icon: UsersRound, accent: '#b88cff' },
];

const refreshHome = async () => {
  await refresh();
  if (!error.value) pendingUpdates.value = 0;
};

const removeNavigationHook = router.afterEach((to, from) => {
  if (to.path === '/' && from.path && !primaryTabRoutes.has(from.path) && data.value) {
    pendingUpdates.value = 2;
  }
});

const selectTab = (tab: string) => {
  activeTab.value = tab;
  selectedGenre.value = 'All';
  void track('filter', { properties: { source: 'home_tab', value: tab } });
};

const moveTabFocus = async (event: KeyboardEvent, currentIndex: number) => {
  const tabs = data.value?.tabs || [];
  if (!tabs.length || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const nextIndex = event.key === 'Home'
    ? 0
    : event.key === 'End'
      ? tabs.length - 1
      : (currentIndex + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
  selectTab(tabs[nextIndex]);
  await nextTick();
  document.getElementById(`tab-${tabs[nextIndex].toLowerCase()}`)?.focus();
};

const selectGenre = (genre: string) => {
  selectedGenre.value = genre;
  void track('filter', { properties: { source: 'home_category', value: genre } });
};

onBeforeUnmount(() => {
  removeNavigationHook();
});

const allSeries = computed(() => {
  if (!data.value) return [];
  return [...new Map(data.value.sections.flatMap((section) => section.items).map((series) => [series.id, series])).values()];
});
const categoryDefinitions = computed(() => {
  const genres = [...new Set(allSeries.value.flatMap((series) => series.genres))];
  const curated = curatedCategoryDefinitions.filter((category) => genres.some((genre) => genre.toLowerCase().includes(category.name.toLowerCase())));
  const extras = genres.filter((genre) => !curated.some((category) => genre.toLowerCase().includes(category.name.toLowerCase()))).map((genre, index) => ({
    name: genre,
    description: 'Stories selected for you',
    icon: [Sparkles, WandSparkles, Heart][index % 3],
    accent: ['#668cff', '#43dbc0', '#f5c967'][index % 3],
  }));
  return [...curated, ...extras];
});
const categoryItems = computed(() => {
  if (selectedGenre.value === 'All') return allSeries.value;
  return allSeries.value.filter((series) => series.genres.some((genre) => genre.toLowerCase().includes(selectedGenre.value.toLowerCase())));
});
const categoryCount = (name: string) => allSeries.value.filter((series) => series.genres.some((genre) => genre.toLowerCase().includes(name.toLowerCase()))).length;
const tabSections = computed(() => {
  if (!data.value) return [];
  if (activeTab.value === 'New') return [data.value.sections.find((section) => section.id === 'new') || data.value.sections[1] || data.value.sections[0]].filter(Boolean);
  if (activeTab.value === 'Rankings') return [data.value.sections.find((section) => section.id === 'popular') || data.value.sections[0]].filter(Boolean);
  return data.value.sections.slice(0, activeTab.value === 'Popular' ? 2 : 1);
});

watch(data, (value) => {
  if (value && !featuredTracked.value) {
    featuredTracked.value = true;
    void track('home_section_exposure', { properties: { sectionId: 'featured' } });
  }
}, { immediate: true });

watch(activeTab, (tab) => {
  void track('home_section_exposure', { properties: { sectionId: tab.toLowerCase() } });
});
</script>

<template>
  <div>
    <AppHeader refreshable :refreshing="status === 'pending'" :pending-updates="pendingUpdates" @refresh="refreshHome" />
    <div v-if="status === 'pending'" class="content-width"><PageSkeleton /></div>
    <div v-else-if="error" class="content-width page-state"><EmptyState title="We lost the signal" message="The latest shows could not be loaded." action="Try again" @action="refreshHome" /></div>
    <template v-else-if="data">
      <section class="featured-strip" :style="{ '--feature-image': `url(${data.featured.backdropUrl})` }">
        <div class="featured-strip__content content-width">
          <span class="live-label"><Flame :size="14" fill="currentColor" /> TRENDING #1 IN THE US</span>
          <h1>{{ data.featured.title }}</h1>
          <p>{{ data.featured.tagline }}</p>
          <div class="featured-strip__meta"><span>{{ data.featured.genres.join(' · ') }}</span><span>{{ formatViews(data.featured.views) }} plays</span></div>
          <NuxtLink class="button button--primary" :to="`/watch/${data.featured.slug}/1`" @click="track('card_click', { seriesId: data.featured.id, seriesTitle: data.featured.title, properties: { placement: 'featured' } })"><Play :size="18" fill="currentColor" /> Watch free</NuxtLink>
        </div>
      </section>

      <div class="sticky-category-wrap">
        <nav class="category-tabs content-width" aria-label="Content categories" role="tablist">
          <button v-for="(tab, tabIndex) in data.tabs" :id="`tab-${tab.toLowerCase()}`" :key="tab" type="button" role="tab" :tabindex="activeTab === tab ? 0 : -1" :aria-selected="activeTab === tab" :aria-controls="`panel-${tab.toLowerCase()}`" :class="{ 'is-active': activeTab === tab }" @click="selectTab(tab)" @keydown="moveTabFocus($event, tabIndex)">{{ tab }}</button>
        </nav>
      </div>

      <div :id="`panel-${activeTab.toLowerCase()}`" class="content-width home-sections" role="tabpanel" :aria-labelledby="`tab-${activeTab.toLowerCase()}`" :class="{ 'home-sections--categories': activeTab === 'Categories' }">
        <template v-if="activeTab === 'Categories'">
          <section class="category-intro" aria-labelledby="category-title">
            <div class="category-intro__copy"><span class="eyebrow">CURATED FOR YOUR MOOD</span><h2 id="category-title">Find your next world</h2><p>Pick a feeling, then press play. Stories are grouped by the tension, romance and chaos you want tonight.</p></div>
            <div class="category-intro__mark"><WandSparkles :size="22" /><span>{{ categoryDefinitions.length }}<br />lanes</span></div>
          </section>
          <section class="category-browser" aria-labelledby="category-browser-title">
            <div class="section-heading category-browser__heading"><div><h2 id="category-browser-title">Story lanes</h2><p>Choose a genre to shape your shelf</p></div><span class="category-browser__count">{{ allSeries.length }} series</span></div>
            <div class="category-tiles">
              <button type="button" class="category-tile category-tile--all" :aria-pressed="selectedGenre === 'All'" :class="{ 'is-active': selectedGenre === 'All' }" style="--category-accent: #f7f4f6" @click="selectGenre('All')">
                <span class="category-tile__icon"><WandSparkles :size="18" /></span><span class="category-tile__copy"><strong>All stories</strong><small>Browse the full ReelNova shelf</small></span><span class="category-tile__count">{{ allSeries.length }}</span>
              </button>
              <button v-for="category in categoryDefinitions" :key="category.name" type="button" class="category-tile" :aria-pressed="selectedGenre === category.name" :class="{ 'is-active': selectedGenre === category.name }" :style="{ '--category-accent': category.accent }" @click="selectGenre(category.name)">
                <span class="category-tile__icon"><component :is="category.icon" :size="18" /></span><span class="category-tile__copy"><strong>{{ category.name }}</strong><small>{{ category.description }}</small></span><span class="category-tile__count">{{ categoryCount(category.name) }}</span>
              </button>
            </div>
          </section>
          <section class="content-section category-results" aria-live="polite">
            <SectionHeader :title="selectedGenre === 'All' ? 'Every kind of story' : selectedGenre" :subtitle="selectedGenre === 'All' ? 'A little bit of everything, all in one place' : `${categoryItems.length} stories in this lane`" to="/explore" />
            <div class="poster-grid"><SeriesCard v-for="series in categoryItems" :key="series.id" :series="series" section-id="categories" /></div>
          </section>
        </template>
        <template v-else>
          <div class="now-playing-line"><span><i /> Now playing</span><strong>2,840 viewers watching</strong></div>
          <section v-for="(section, sectionIndex) in tabSections" :id="section.id" :key="section.id" class="content-section">
            <SectionHeader :title="activeTab === 'Rankings' ? 'Top 10 this week' : section.title" :subtitle="activeTab === 'Rankings' ? 'The stories everyone is talking about' : section.subtitle" :to="`/explore?section=${section.id}`" />
            <div class="poster-grid"><SeriesCard v-for="(series, index) in section.items" :key="series.id" :series="series" :section-id="section.id" :rank="activeTab === 'Rankings' || sectionIndex === 0 ? index + 1 : undefined" /></div>
            <NuxtLink v-if="sectionIndex === 0" class="section-inline-link" to="/explore">Explore every series <ChevronRight :size="17" /></NuxtLink>
          </section>
        </template>
      </div>
    </template>
  </div>
</template>
