<script setup lang="ts">
import { ArrowLeft, Captions, ChevronRight, Gauge, LockKeyhole, MoreHorizontal, Pause, Play, RotateCcw, Share2, SkipForward, Volume2, VolumeX } from 'lucide-vue-next';

definePageMeta({ layout: false });
const route = useRoute();
const api = useContentApi();
const episodeNo = computed(() => Number(route.params.episode || 1));
const isPlaying = ref(false);
const muted = ref(false);
const showControls = ref(true);
const showUnlock = ref(false);
const locallyUnlocked = ref(false);
const progress = ref(18);
const playbackError = ref('');
const { data: series, status } = await useAsyncData(`watch-${route.params.slug}`, () => api.getSeries(String(route.params.slug)));
const currentEpisode = computed(() => series.value?.episodes.find((episode) => episode.episodeNo === episodeNo.value));
const canPlay = computed(() => Boolean(currentEpisode.value?.isUnlocked || locallyUnlocked.value));

const togglePlayback = async () => {
  if (isPlaying.value) { isPlaying.value = false; return; }
  if (!series.value || !currentEpisode.value || !canPlay.value) return;
  try {
    const sessionKey = 'rn_playback_session';
    const sessionId = sessionStorage.getItem(sessionKey) || crypto.randomUUID();
    sessionStorage.setItem(sessionKey, sessionId);
    const authorization = await api.getPlayback(series.value.id, currentEpisode.value.episodeNo, sessionId);
    await api.recordPlayback({
      eventId: crypto.randomUUID(), sessionId, seriesId: series.value.id, seriesTitle: series.value.title,
      episodeNo: currentEpisode.value.episodeNo, eventType: 'start', positionSeconds: 0, durationSeconds: 0, authorizationToken: authorization.trackingToken,
    });
    isPlaying.value = true;
  } catch { playbackError.value = 'Playback authorization expired.'; }
};

const nextEpisode = () => {
  if (!series.value || episodeNo.value >= series.value.episodeCount) return;
  const next = series.value.episodes[episodeNo.value];
  if (!next?.isUnlocked && !locallyUnlocked.value) { showUnlock.value = true; return; }
  navigateTo(`/watch/${series.value.slug}/${episodeNo.value + 1}`);
};

const retry = () => { playbackError.value = ''; isPlaying.value = true; };
</script>

<template>
  <main v-if="series && currentEpisode" class="watch-page" @click="showControls = !showControls">
    <div class="watch-visual" :style="{ '--watch-image': `url(${series.backdropUrl})` }" />
    <div class="watch-vignette" />
    <Transition name="fade">
      <div v-if="showControls" class="watch-top" @click.stop><button type="button" aria-label="Back" @click="$router.back()"><ArrowLeft :size="22" /></button><div><strong>{{ series.title }}</strong><span>Episode {{ episodeNo }} · {{ currentEpisode.title }}</span></div><button type="button" aria-label="Share"><Share2 :size="20" /></button><button type="button" aria-label="More"><MoreHorizontal :size="21" /></button></div>
    </Transition>
    <button v-if="canPlay && !playbackError" class="watch-center" type="button" :aria-label="isPlaying ? 'Pause' : 'Play'" @click.stop="togglePlayback"><Pause v-if="isPlaying" :size="32" fill="currentColor" /><Play v-else :size="34" fill="currentColor" /></button>
    <section v-if="!canPlay" class="watch-lock" @click.stop><span><LockKeyhole :size="28" /></span><p>Episode {{ episodeNo }} is locked</p><h1>Keep the story going</h1><button class="button button--primary button--wide" type="button" @click="showUnlock = true">Unlock full series</button><button class="watch-lock__secondary" type="button" @click="$router.back()">Choose another episode</button></section>
    <section v-if="playbackError" class="watch-lock" @click.stop><span><RotateCcw :size="27" /></span><h1>Connection interrupted</h1><p>{{ playbackError }} Refresh access to continue.</p><button class="button button--primary" type="button" @click="retry">Retry playback</button></section>
    <Transition name="fade">
      <div v-if="showControls && canPlay" class="watch-bottom" @click.stop>
        <div class="watch-progress"><span :style="{ width: `${progress}%` }" /><i :style="{ left: `${progress}%` }" /></div><div class="watch-time"><span>0:24</span><span>{{ currentEpisode.duration }}</span></div>
        <div class="watch-controls"><button type="button" :aria-label="muted ? 'Unmute' : 'Mute'" @click="muted = !muted"><VolumeX v-if="muted" :size="21" /><Volume2 v-else :size="21" /></button><button type="button"><Captions :size="22" /><span>CC</span></button><button type="button"><Gauge :size="22" /><span>1.0×</span></button><button type="button" @click="nextEpisode"><SkipForward :size="22" /><span>Next</span></button></div>
        <button class="up-next" type="button" @click="nextEpisode"><span>UP NEXT</span><strong>Episode {{ episodeNo + 1 }}</strong><ChevronRight :size="20" /></button>
      </div>
    </Transition>
    <UnlockSheet :series="series" :open="showUnlock" @close="showUnlock = false" @unlocked="locallyUnlocked = true; showUnlock = false" />
  </main>
  <main v-else class="watch-page watch-page--loading"><div class="skeleton skeleton--poster" /><span>{{ status === 'pending' ? 'Preparing episode…' : 'Episode unavailable' }}</span></main>
</template>
