<script setup lang="ts">
import { Search, SlidersHorizontal, X } from 'lucide-vue-next';
import { useAnalytics } from '~/composables/useAnalytics';
import { usePageData } from '~/composables/usePageData';

definePageMeta({ keepalive: true });
const api = useContentApi();
const route = useRoute();
const router = useRouter();
const query = ref(String(route.query.q || ''));
const activeGenre = ref(String(route.query.genre || 'All'));
const sort = ref(String(route.query.sort || 'Popular'));
const showFilters = ref(false);
const sortOptions = ['Popular', 'Newest', 'Most Watched', 'Most Purchased'];
const exploreParams = () => ({
  ...(query.value.trim() ? { q: query.value.trim() } : {}),
  ...(activeGenre.value !== 'All' ? { genre: activeGenre.value } : {}),
  ...(sort.value !== 'Popular' ? { sort: sort.value } : {}),
});
const { data, status, error, refresh } = usePageData('explore-v2', () => api.getExplore(exploreParams()), { revalidateOnMount: true });
const genres = computed(() => ['All', ...(data.value?.genres || [])]);
const { track } = useAnalytics();
let searchTimer: ReturnType<typeof setTimeout> | undefined;

const filtered = computed(() => {
  return data.value?.items || [];
});

watch([query, activeGenre, sort], () => {
  router.replace({ query: {
    ...(query.value ? { q: query.value } : {}),
    ...(activeGenre.value !== 'All' ? { genre: activeGenre.value } : {}),
    ...(sort.value !== 'Popular' ? { sort: sort.value } : {}),
  } });
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    void refresh();
    if (query.value.trim()) void track('search', { properties: { query: query.value.trim().slice(0, 100), resultCount: filtered.value.length } });
    if (activeGenre.value !== 'All') void track('filter', { properties: { genre: activeGenre.value, sort: sort.value, resultCount: filtered.value.length } });
  }, 400);
});

onBeforeUnmount(() => { if (searchTimer) clearTimeout(searchTimer); });

const reset = () => { query.value = ''; activeGenre.value = 'All'; sort.value = 'Popular'; };
</script>

<template>
  <div class="content-width page-top">
    <AppHeader compact refreshable :refreshing="status === 'pending'" @refresh="refresh" />
    <header class="page-title"><span class="eyebrow">FIND YOUR NEXT OBSESSION</span><h1>Explore</h1></header>
    <div class="search-row">
      <label class="search-field"><Search :size="19" /><input v-model="query" type="search" placeholder="Title, cast or tag" /><button v-if="query" type="button" aria-label="Clear search" @click="query = ''"><X :size="17" /></button></label>
      <button class="filter-button" type="button" aria-label="Filters" :class="{ 'is-active': showFilters }" @click="showFilters = !showFilters"><SlidersHorizontal :size="20" /></button>
    </div>
    <div class="chip-row" aria-label="Genres"><button v-for="genre in genres" :key="genre" type="button" :class="{ 'is-active': activeGenre === genre }" @click="activeGenre = genre">{{ genre }}</button></div>
    <div v-if="showFilters" class="sort-panel"><span>Sort by</span><div class="segmented-control"><button v-for="option in sortOptions" :key="option" type="button" :class="{ 'is-active': sort === option }" @click="sort = option">{{ option }}</button></div></div>
    <div class="results-heading"><strong>{{ filtered.length }} series</strong><span>English · United States</span></div>
    <PageSkeleton v-if="status === 'pending'" />
    <EmptyState v-else-if="error" title="Could not load Explore" action="Try again" @action="refresh" />
    <EmptyState v-else-if="!filtered.length" title="No matching series" message="Clear a filter or search for another story." @action="reset" />
    <div v-else class="poster-grid explore-grid"><SeriesCard v-for="series in filtered" :key="series.id" :series="series" /></div>
  </div>
</template>
