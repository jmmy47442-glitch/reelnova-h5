<script setup lang="ts">
import { ArrowLeft, Captions, ChevronRight, Gauge, LockKeyhole, Maximize2, MoreHorizontal, Pause, Play, RotateCcw, Share2, SkipForward, Volume2, VolumeX } from 'lucide-vue-next';
import Hls from 'hls.js';
import { useSafeBack } from '~/composables/useSafeBack';

definePageMeta({ layout: false });
const route = useRoute();
const api = useContentApi();
const goBack = useSafeBack(() => `/series/${String(route.params.slug)}`);
const episodeNo = computed(() => Number(route.params.episode || 1));
const video = ref<HTMLVideoElement | null>(null);
const isPlaying = ref(false);
const muted = ref(false);
const showControls = ref(true);
const showUnlock = ref(false);
const locallyUnlocked = ref(false);
const signedUrl = ref('');
const trackingToken = ref('');
const sessionId = ref('');
const expiresAt = ref(0);
const progress = ref(0);
const currentTime = ref(0);
const durationSeconds = ref(0);
const playbackError = ref('');
const speed = ref(1);
const started = ref(false);
const lastHeartbeat = ref(0);
const renewing = ref(false);
const resumePosition = ref(0);
let renewTimer: ReturnType<typeof setTimeout> | undefined;
let hls: Hls | undefined;
let recordQueue: Promise<void> = Promise.resolve();

const { data: series, status } = await useAsyncData(`watch-${route.params.slug}`, () => api.getSeries(String(route.params.slug)));
const currentEpisode = computed(() => series.value?.episodes.find((episode) => episode.episodeNo === episodeNo.value));
const canPlay = computed(() => Boolean(currentEpisode.value?.isUnlocked || currentEpisode.value?.isFree || locallyUnlocked.value));

const session = () => {
  if (!sessionId.value) sessionId.value = crypto.randomUUID();
  return sessionId.value;
};
const formatTime = (value: number) => {
  const safe = Math.max(0, Math.floor(value || 0));
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, '0')}`;
};
const durationLabel = computed(() => formatTime(durationSeconds.value) !== '0:00' ? formatTime(durationSeconds.value) : currentEpisode.value?.duration || '0:00');

const snapshotPlayback = () => {
  if (!video.value) return;
  currentTime.value = Number.isFinite(video.value.currentTime) ? Math.max(0, video.value.currentTime) : currentTime.value;
  durationSeconds.value = Number.isFinite(video.value.duration) ? Math.max(0, video.value.duration) : durationSeconds.value;
  progress.value = durationSeconds.value ? Math.min(100, currentTime.value / durationSeconds.value * 100) : 0;
};
const record = (eventType: 'start' | 'heartbeat' | 'complete', keepalive = false) => {
  if (!series.value || !currentEpisode.value || !trackingToken.value) return;
  snapshotPlayback();
  const payload = {
    eventId: crypto.randomUUID(), sessionId: session(), seriesId: series.value.id, seriesTitle: series.value.title,
    episodeNo: currentEpisode.value.episodeNo, eventType, positionSeconds: currentTime.value, durationSeconds: durationSeconds.value, authorizationToken: trackingToken.value,
  };
  const submit = () => api.recordPlayback(payload, keepalive).then(() => undefined).catch(() => undefined);
  if (keepalive) return submit();
  recordQueue = recordQueue.then(submit, submit);
  return recordQueue;
};

const scheduleRenewal = () => {
  if (renewTimer) clearTimeout(renewTimer);
  const wait = Math.max(15_000, expiresAt.value - Date.now() - 60_000);
  renewTimer = setTimeout(() => { void authorize(true); }, wait);
};
const loadSource = (source: string, restoreAt: number, shouldPlay: boolean) => {
  if (!video.value) return;
  hls?.destroy();
  hls = undefined;
  const restore = () => {
    if (!video.value) return;
    if (restoreAt > 0 && restoreAt < (video.value.duration || Infinity) - 3) video.value.currentTime = restoreAt;
    snapshotPlayback();
    if (shouldPlay) void video.value.play().catch(() => undefined);
    video.value.removeEventListener('loadedmetadata', restore);
  };
  video.value.addEventListener('loadedmetadata', restore);
  if (video.value.canPlayType('application/vnd.apple.mpegurl')) {
    video.value.src = source;
    video.value.load();
    return;
  }
  if (!Hls.isSupported()) throw new Error('HLS playback is not supported');
  hls = new Hls({ enableWorker: true, lowLatencyMode: false, backBufferLength: 30 });
  hls.on(Hls.Events.ERROR, (_event, data) => {
    if (!data.fatal) return;
    if (data.type === Hls.ErrorTypes.NETWORK_ERROR) hls?.startLoad();
    else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hls?.recoverMediaError();
    else { hls?.destroy(); playbackError.value = 'The video stream stopped unexpectedly. Please retry.'; }
  });
  hls.loadSource(source);
  hls.attachMedia(video.value);
};
const authorize = async (renew = false) => {
  if (!series.value || !currentEpisode.value || renewing.value) return;
  renewing.value = true;
  try {
    const oldTime = video.value?.currentTime || currentTime.value;
    const wasPlaying = isPlaying.value;
    const authorization = await api.getPlayback(series.value.id, currentEpisode.value.episodeNo, session());
    if (!authorization.signedUrl) throw new Error('No playable source');
    signedUrl.value = authorization.signedUrl;
    trackingToken.value = authorization.trackingToken;
    expiresAt.value = Date.parse(authorization.expiresAt || '') || Date.now() + 9 * 60_000;
    if (!renew && !started.value) {
      resumePosition.value = authorization.resumePositionSeconds || 0;
      currentTime.value = resumePosition.value;
      durationSeconds.value = authorization.resumeDurationSeconds || durationSeconds.value;
      progress.value = durationSeconds.value ? Math.min(100, currentTime.value / durationSeconds.value * 100) : 0;
    }
    if (video.value) loadSource(authorization.signedUrl, !renew && resumePosition.value > 0 ? resumePosition.value : oldTime, renew && wasPlaying);
    playbackError.value = '';
    scheduleRenewal();
  } catch {
    playbackError.value = 'This stream could not be loaded. Check your connection and try again.';
    isPlaying.value = false;
  } finally { renewing.value = false; }
};

const togglePlayback = async () => {
  if (!video.value || !canPlay.value) return;
  if (!signedUrl.value) await authorize();
  if (!video.value || !signedUrl.value || playbackError.value) return;
  try {
    if (video.value.paused) await video.value.play();
    else video.value.pause();
  } catch { playbackError.value = 'Tap retry to start this episode.'; }
};
const onPlay = () => {
  isPlaying.value = true;
  snapshotPlayback();
  if (!started.value) { started.value = true; lastHeartbeat.value = Date.now(); void record('start'); }
};
const onPause = () => {
  isPlaying.value = false;
  if (started.value && !video.value?.ended) void record('heartbeat');
};
const onTimeUpdate = () => {
  if (!video.value) return;
  currentTime.value = video.value.currentTime;
  durationSeconds.value = Number.isFinite(video.value.duration) ? video.value.duration : durationSeconds.value;
  progress.value = durationSeconds.value ? Math.min(100, currentTime.value / durationSeconds.value * 100) : 0;
  if (isPlaying.value && Date.now() - lastHeartbeat.value > 15_000) { lastHeartbeat.value = Date.now(); void record('heartbeat'); }
};
const onLoadedMetadata = () => { snapshotPlayback(); };
const onEnded = async () => { isPlaying.value = false; snapshotPlayback(); progress.value = 100; await record('complete'); };
const seek = (event: Event) => {
  const value = Number((event.target as HTMLInputElement).value);
  if (video.value && durationSeconds.value) {
    video.value.currentTime = value / 100 * durationSeconds.value;
    snapshotPlayback();
  }
};
const persistSeek = () => { if (started.value) void record('heartbeat'); };
const toggleMute = () => { muted.value = !muted.value; if (video.value) video.value.muted = muted.value; };
const cycleSpeed = () => { const values = [1, 1.25, 1.5, 2]; speed.value = values[(values.indexOf(speed.value) + 1) % values.length] || 1; if (video.value) video.value.playbackRate = speed.value; };
const fullscreen = () => { if (video.value?.requestFullscreen) void video.value.requestFullscreen(); };
const returnToSeries = () => navigateTo(`/series/${String(route.params.slug)}`, { replace: true });
const nextEpisode = () => {
  if (!series.value || episodeNo.value >= series.value.episodeCount) return;
  const next = series.value.episodes[episodeNo.value];
  if (!next?.isUnlocked && !next?.isFree && !locallyUnlocked.value) { showUnlock.value = true; return; }
  if (!video.value?.ended) void record('heartbeat');
  navigateTo(`/watch/${series.value.slug}/${episodeNo.value + 1}`);
};
const retry = async () => { playbackError.value = ''; await authorize(); await togglePlayback(); };
const share = async () => { await navigator.clipboard?.writeText(window.location.href).catch(() => undefined); };
const persistOnExit = () => { if (started.value && !video.value?.ended) void record('heartbeat', true); };
const persistWhenHidden = () => { if (document.visibilityState === 'hidden') persistOnExit(); };

onMounted(() => {
  window.addEventListener('pagehide', persistOnExit);
  document.addEventListener('visibilitychange', persistWhenHidden);
});
onBeforeUnmount(() => {
  if (renewTimer) clearTimeout(renewTimer);
  window.removeEventListener('pagehide', persistOnExit);
  document.removeEventListener('visibilitychange', persistWhenHidden);
  if (started.value && !video.value?.ended) void record('heartbeat', true);
  hls?.destroy();
});
</script>

<template>
  <main v-if="series && currentEpisode" class="watch-page" @click="showControls = !showControls">
    <div class="watch-visual" :style="{ '--watch-image': `url(${series.backdropUrl})` }" />
    <video v-if="canPlay" ref="video" class="watch-video" :poster="series.backdropUrl" playsinline preload="metadata" @click.stop @play="onPlay" @pause="onPause" @timeupdate="onTimeUpdate" @loadedmetadata="onLoadedMetadata" @ended="onEnded" @error="playbackError = 'The video stream is unavailable. Please retry.'; isPlaying = false" />
    <div class="watch-vignette" />
    <Transition name="fade"><div v-if="showControls" class="watch-top" @click.stop><button type="button" aria-label="Go back" @click="goBack"><ArrowLeft :size="22" /></button><div><strong>{{ series.title }}</strong><span>Episode {{ episodeNo }} · {{ currentEpisode.title }}</span></div><button type="button" aria-label="Share" @click="share"><Share2 :size="20" /></button><button type="button" aria-label="More"><MoreHorizontal :size="21" /></button></div></Transition>
    <button v-if="canPlay && !playbackError" class="watch-center" type="button" :aria-label="isPlaying ? 'Pause' : 'Play'" @click.stop="togglePlayback"><Pause v-if="isPlaying" :size="32" fill="currentColor" /><Play v-else :size="34" fill="currentColor" /></button>
    <section v-if="!canPlay" class="watch-lock" @click.stop><span><LockKeyhole :size="28" /></span><p>Episode {{ episodeNo }} is locked</p><h1>Keep the story going</h1><button class="button button--primary button--wide" type="button" @click="showUnlock = true">Unlock full series</button><button class="watch-lock__secondary" type="button" @click="returnToSeries">Choose another episode</button></section>
    <section v-if="playbackError" class="watch-lock" @click.stop><span><RotateCcw :size="27" /></span><h1>Connection interrupted</h1><p>{{ playbackError }}</p><button class="button button--primary" type="button" @click="retry">Retry playback</button></section>
    <Transition name="fade"><div v-if="showControls && canPlay" class="watch-bottom" @click.stop><input class="watch-progress-input" type="range" min="0" max="100" step="0.1" :value="progress" aria-label="Seek" @input="seek" @change="persistSeek" /><div class="watch-time"><span>{{ formatTime(currentTime) }}</span><span>{{ durationLabel }}</span></div><div class="watch-controls"><button type="button" :aria-label="muted ? 'Unmute' : 'Mute'" @click="toggleMute"><VolumeX v-if="muted" :size="21" /><Volume2 v-else :size="21" /></button><button type="button" aria-label="Captions"><Captions :size="22" /><span>CC</span></button><button type="button" aria-label="Playback speed" @click="cycleSpeed"><Gauge :size="22" /><span>{{ speed }}×</span></button><button type="button" aria-label="Fullscreen" @click="fullscreen"><Maximize2 :size="21" /></button><button type="button" aria-label="Next episode" @click="nextEpisode"><SkipForward :size="22" /><span>Next</span></button></div><button v-if="episodeNo < series.episodeCount" class="up-next" type="button" @click="nextEpisode"><span>UP NEXT</span><strong>Episode {{ episodeNo + 1 }}</strong><ChevronRight :size="20" /></button></div></Transition>
    <UnlockSheet :series="series" :open="showUnlock" @close="showUnlock = false" @unlocked="locallyUnlocked = true; showUnlock = false" />
  </main>
  <main v-else class="watch-page watch-page--loading"><div class="skeleton skeleton--poster" /><span>{{ status === 'pending' ? 'Preparing episode…' : 'Episode unavailable' }}</span></main>
</template>
