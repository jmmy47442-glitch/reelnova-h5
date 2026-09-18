<script setup lang="ts">
import { ArrowLeft, Check, ChevronRight, Gauge, History, Loader2, LockKeyhole, Maximize2, Minimize2, Pause, Play, RotateCcw, Settings2, SkipForward, X } from 'lucide-vue-next';
import Hls from 'hls.js';
import { canPrefetchPlayback, handoffPlayback, playbackProfile, prefetchHlsStart, prefetchPlaybackStart, takePlaybackHandoff } from '~/utils/playback-prefetch';
import type { PlaybackAuthorization } from '~/composables/useContentApi';
import { enterVideoFullscreen, exitVideoFullscreen, type FullscreenDocument } from '~/utils/video-fullscreen';
import { useSafeBack } from '~/composables/useSafeBack';
import { useAnalytics } from '~/composables/useAnalytics';
import { invalidatePageDataCache, usePageData } from '~/composables/usePageData';
import { normalizeVideoQualityLevels, parseHlsQualityManifest, resolveVideoQualityLevel, type VideoQualityLevel, type VideoQualityPreference } from '~/utils/video-quality';

definePageMeta({ hideBottomNav: true });
const route = useRoute();
const api = useContentApi();
const goBack = useSafeBack(() => `/series/${String(route.params.slug)}`);
const { track } = useAnalytics();
const episodeNo = computed(() => Number(route.params.episode || 1));
const video = ref<HTMLVideoElement | null>(null);
const player = ref<HTMLElement | null>(null);
const isFullscreen = ref(false);
const fullscreenPending = ref(false);
const fullscreenError = ref('');
const isPlaying = ref(false);
const showControls = ref(true);
const showUnlock = ref(false);
const locallyUnlocked = ref(false);
const signedUrl = ref('');
const originalUrl = ref('');
const directMp4 = ref(false);
const trackingToken = ref('');
const sessionId = ref('');
const expiresAt = ref(0);
const progress = ref(0);
const bufferedSegments = ref<Array<{ left: number; width: number }>>([]);
const currentTime = ref(0);
const durationSeconds = ref(0);
const playbackError = ref('');
const playbackLoading = ref(false);
const playbackReady = ref(false);
const firstFrameReady = ref(false);
const playRequested = ref(false);
const speed = ref(1);
const qualityPreference = ref<VideoQualityPreference>('auto');
const qualityLevels = ref<VideoQualityLevel[]>([]);
const showQualityDrawer = ref(false);
const qualityTrigger = ref<HTMLButtonElement | null>(null);
const qualityDrawer = ref<HTMLElement | null>(null);
const closeQualityDrawer = () => {
  showQualityDrawer.value = false;
  void nextTick(() => qualityTrigger.value?.focus());
};
const openQualityDrawer = async () => {
  showQualityDrawer.value = true;
  await nextTick();
  qualityDrawer.value?.querySelector<HTMLButtonElement>('.is-selected, button')?.focus();
};
const trapQualityFocus = (event: KeyboardEvent) => {
  const buttons = qualityDrawer.value?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)');
  if (!buttons?.length) return;
  const first = buttons[0]!;
  const last = buttons[buttons.length - 1]!;
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
};
const nativeQualityOnly = ref(false);
const started = ref(false);
const lastHeartbeat = ref(0);
const renewing = ref(false);
const resumePosition = ref(0);
const firstFrameTracked = ref(false);
const playbackStartedAt = ref(0);
const stalled = ref(false);
const networkSpeedMbps = ref<number | null>(null);
const networkRttMs = ref<number | null>(null);
const sourceTransition = ref(false);
const seeking = ref(false);
const resumeFallbackAttempted = ref(false);
const showResumePrompt = ref(false);
const resumePromptPosition = ref(0);
const resumePromptDuration = ref(0);
const resumePromptResolved = ref(false);
const resumePromptResolving = ref(false);
const resumeCloseButton = ref<HTMLButtonElement | null>(null);
const resumeContinueButton = ref<HTMLButtonElement | null>(null);
const resumeRestartButton = ref<HTMLButtonElement | null>(null);
const initialGrantRequested = ref(false);
const activeSourceUrl = ref('');
const originalPlayback = ref(false);
const rendition = ref<'original' | 'mobile'>('original');
let nextPrefetchController: AbortController | undefined;
let nextPrefetchAttempted = false;
let prefetchedNext: { episodeNo: number; sessionId: string; grant: PlaybackAuthorization } | undefined;
const stopNextPrefetch = () => { nextPrefetchController?.abort(); nextPrefetchController = undefined; };
const originalFallbackAttempted = ref(false);
const canUseOriginalSource = computed(() => Boolean(originalUrl.value) && !originalFallbackAttempted.value);
let renewTimer: ReturnType<typeof setTimeout> | undefined;
let sourceTransitionTimer: ReturnType<typeof setTimeout> | undefined;
let hls: Hls | undefined;
let recordQueue: Promise<void> = Promise.resolve();
let nativeHlsPlayback = false;
let networkResourceObserver: PerformanceObserver | undefined;
let initialGrantPromise: ReturnType<typeof api.getPlaybackBySlug> | undefined;
let seekTargetSeconds = 0;
let seekStartedAt = 0;
let seekShouldResume = false;
let seekRecoveryAttempted = false;
const networkSamples: Array<{ bytes: number; durationMs: number; latencyMs: number | null }> = [];
const measuredResourceKeys = new Set<string>();
const resumeFallbackWindowSeconds = 5;
const seekRecoveryWindowMs = 8_000;
const networkSpeedLabel = computed(() => {
  if (networkSpeedMbps.value !== null) return `${networkSpeedMbps.value.toFixed(networkSpeedMbps.value >= 10 ? 0 : 1)} Mbps`;
  return 'Measuring connection';
});
const networkDetailLabel = computed(() => networkRttMs.value !== null ? `${networkSpeedLabel.value} · ${networkRttMs.value} ms latency` : networkSpeedLabel.value);
const playbackLoadingLabel = computed(() => {
  if (stalled.value) return 'Buffering video';
  if (!signedUrl.value) return 'Connecting to stream';
  if (!firstFrameReady.value) return 'Loading video';
  return 'Preparing playback';
});
const recordNetworkSample = (bytes: number, durationMs: number, latencyMs: number | null = null) => {
  if (!Number.isFinite(bytes) || bytes <= 0 || !Number.isFinite(durationMs) || durationMs <= 0) return;
  networkSamples.push({
    bytes,
    durationMs,
    latencyMs: latencyMs !== null && Number.isFinite(latencyMs) && latencyMs >= 0 ? latencyMs : null,
  });
  // A short rolling window keeps the label responsive while smoothing tiny
  // init segments and avoids replacing measured throughput with an estimate.
  while (networkSamples.length > 6) networkSamples.shift();
  const totalBytes = networkSamples.reduce((sum, sample) => sum + sample.bytes, 0);
  const totalDurationMs = networkSamples.reduce((sum, sample) => sum + sample.durationMs, 0);
  networkSpeedMbps.value = totalBytes * 8 / totalDurationMs / 1000;
  const latencySamples = networkSamples.filter((sample) => sample.latencyMs !== null);
  if (latencySamples.length) {
    networkRttMs.value = Math.round(latencySamples.reduce((sum, sample) => sum + (sample.latencyMs || 0), 0) / latencySamples.length);
  }
};
const isNativeMediaResource = (entry: PerformanceResourceTiming) => {
  if (entry.initiatorType === 'video') return true;
  return /(?:\.m3u8|\.mp4|\.m4s|\.ts)(?:[?#]|$)|(?:^|[\\/_-])(?:seg|init)[-_\\d]/i.test(entry.name);
};
const sampleNativeMediaTimings = (entries: PerformanceEntry[]) => {
  if (!nativeHlsPlayback) return;
  entries.forEach((entry) => {
    if (!(entry instanceof PerformanceResourceTiming) || !isNativeMediaResource(entry)) return;
    const resource = entry as PerformanceResourceTiming;
    const key = `${resource.name}:${resource.responseEnd}`;
    if (measuredResourceKeys.has(key)) return;
    measuredResourceKeys.add(key);
    // A zero transferSize with a non-zero body means the browser served the
    // entry from cache; it is not a network-speed sample.
    if (resource.transferSize <= 0) return;
    const bytes = resource.transferSize;
    const durationMs = resource.responseEnd - resource.startTime;
    const latencyMs = resource.responseStart > 0 ? resource.responseStart - resource.startTime : null;
    recordNetworkSample(bytes, durationMs, latencyMs);
  });
};

// Reuse the cached series snapshot for an immediate paint, then revalidate so
// access changes are reflected when opening a playback route directly.
const { data: series, status, refresh } = usePageData(
  // Share the detail snapshot with the series page so returning from playback
  // never triggers a second series request.
  `series-${String(route.params.slug)}`,
  () => api.getSeries(String(route.params.slug)),
  { revalidateOnMount: true },
);
const currentEpisode = computed(() => series.value?.episodes.find((episode) => episode.episodeNo === episodeNo.value));
const canPlay = computed(() => Boolean(currentEpisode.value?.isUnlocked || currentEpisode.value?.isFree || locallyUnlocked.value));
const purchasable = computed(() => Number(series.value?.price) > 0);

const session = () => {
  if (!sessionId.value) sessionId.value = crypto.randomUUID();
  return sessionId.value;
};
const formatTime = (value: number) => {
  const safe = Math.max(0, Math.floor(value || 0));
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, '0')}`;
};
const durationLabel = computed(() => formatTime(durationSeconds.value) !== '0:00' ? formatTime(durationSeconds.value) : currentEpisode.value?.duration || '0:00');
const qualitySelectValue = computed(() => nativeQualityOnly.value ? 'auto' : typeof qualityPreference.value === 'number'
  ? `resolution:${qualityPreference.value}`
  : qualityPreference.value);
const qualityControlLabel = computed(() => {
  if (directMp4.value && rendition.value === 'mobile') return 'Data saver';
  if (nativeQualityOnly.value) return 'Auto';
  if (qualityPreference.value === 'original') return canUseOriginalSource.value ? 'Original' : qualityLevels.value[0]?.label || 'Highest';
  if (qualityPreference.value === 'auto') return 'Auto';
  return `${qualityPreference.value}P`;
});

const qualityOptions = computed(() => directMp4.value ? [{ value: 'original', label: 'Original', detail: 'Source quality' }] : [
  { value: 'auto', label: 'Auto', detail: 'Adjusts to your connection' },
  ...(canUseOriginalSource.value || (!nativeQualityOnly.value && qualityLevels.value.length)
    ? [{ value: 'original', label: canUseOriginalSource.value ? 'Original' : 'Highest', detail: canUseOriginalSource.value ? 'Source quality' : 'Highest available quality' }] : []),
  ...(!nativeQualityOnly.value ? qualityLevels.value.map(level => ({ value: `resolution:${level.resolution}`, label: level.label, detail: level.resolution >= 720 ? 'High definition' : 'Uses less data' })) : []),
]);

const snapshotPlayback = () => {
  if (!video.value) return;
  currentTime.value = Number.isFinite(video.value.currentTime) ? Math.max(0, video.value.currentTime) : currentTime.value;
  durationSeconds.value = Number.isFinite(video.value.duration) ? Math.max(0, video.value.duration) : durationSeconds.value;
  progress.value = durationSeconds.value ? Math.min(100, currentTime.value / durationSeconds.value * 100) : 0;
};
const updateBuffered = () => {
  const media = video.value;
  const mediaDuration = media && Number.isFinite(media.duration) && media.duration > 0
    ? media.duration
    : durationSeconds.value;
  if (!media || !mediaDuration) {
    bufferedSegments.value = [];
    return;
  }
  const segments: Array<{ left: number; width: number }> = [];
  for (let index = 0; index < media.buffered.length; index += 1) {
    const start = Math.max(0, Math.min(mediaDuration, media.buffered.start(index)));
    const end = Math.max(start, Math.min(mediaDuration, media.buffered.end(index)));
    if (end > start) segments.push({ left: start / mediaDuration * 100, width: (end - start) / mediaDuration * 100 });
  }
  bufferedSegments.value = segments;
};
const inspectQualityLevels = async (source: string) => {
  try {
    const response = await fetch(source);
    if (!response.ok) return;
    const discovered = parseHlsQualityManifest(await response.text());
    if (source === signedUrl.value && discovered.length) qualityLevels.value = discovered;
  } catch {
    // Playback still exposes Auto and Original when a browser blocks manifest inspection.
  }
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
  if (directMp4.value) { loadOriginalSource(source, restoreAt, shouldPlay); return; }
  if (!video.value) return;
  // Replacing an MSE source can briefly emit a native `error` event even when
  // the new manifest is valid. Keep that transient event from blanking a
  // playing episode while an authorization renewal swaps the source.
  activeSourceUrl.value = source;
  sourceTransition.value = true;
  playbackReady.value = false;
  firstFrameReady.value = false;
  if (shouldPlay || !started.value) playbackLoading.value = true;
  if (sourceTransitionTimer) clearTimeout(sourceTransitionTimer);
  sourceTransitionTimer = setTimeout(() => { sourceTransition.value = false; }, 3_000);
  bufferedSegments.value = [];
  hls?.destroy();
  hls = undefined;
  nativeHlsPlayback = false;
  originalPlayback.value = false;
  nativeQualityOnly.value = false;
  qualityLevels.value = [];
  const restore = () => {
    if (!video.value) return;
    if (restoreAt > 0 && restoreAt < (video.value.duration || Infinity) - 3) video.value.currentTime = restoreAt;
    snapshotPlayback();
    if (shouldPlay) void video.value.play().catch(() => undefined);
    sourceTransition.value = false;
    if (sourceTransitionTimer) clearTimeout(sourceTransitionTimer);
    video.value.removeEventListener('loadedmetadata', restore);
  };
  video.value.addEventListener('loadedmetadata', restore);
  if (Hls.isSupported()) {
    hls = new Hls({
      enableWorker: true,
      lowLatencyMode: false,
      autoStartLoad: false,
      capLevelToPlayerSize: true,
      abrEwmaDefaultEstimate: 600_000,
      abrBandWidthFactor: 0.8,
      abrBandWidthUpFactor: 0.65,
      // Wait for MANIFEST_PARSED to select the requested quality before fetching video.
      startFragPrefetch: false,
      // VOD playback needs enough forward buffer to absorb short throughput
      // drops. The previous 12-second cap made a 0.5-0.7 Mbps stream run dry
      // after the initial burst even though every segment request succeeded.
      maxBufferLength: 30,
      maxMaxBufferLength: 120,
      backBufferLength: 30,
    });
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      if (!hls) return;
      qualityLevels.value = normalizeVideoQualityLevels(hls.levels);
      const selectedLevel = resolveVideoQualityLevel(qualityLevels.value, qualityPreference.value);
      // Fetch a small first segment immediately, then let ABR follow measured bandwidth.
      hls.startLevel = qualityPreference.value === 'auto' ? 0 : selectedLevel;
      hls.loadLevel = selectedLevel;
      hls.startLoad(restoreAt > 0 ? restoreAt : -1);
    });
    hls.on(Hls.Events.FRAG_LOADED, (_event, data) => {
      const stats = data.frag?.stats;
      const startedAt = Number(stats?.loading?.start || 0);
      const firstByteAt = Number(stats?.loading?.first || 0);
      const endedAt = Number(stats?.loading?.end || 0);
      const loadedBytes = Number(stats?.loaded || 0);
      const elapsedMs = endedAt - startedAt;
      const latencyMs = firstByteAt > 0 && startedAt > 0 ? firstByteAt - startedAt : null;
      recordNetworkSample(loadedBytes, elapsedMs, latencyMs);
    });
    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (!data.fatal) return;
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR) hls?.startLoad();
      else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hls?.recoverMediaError();
      else {
        hls?.destroy();
        playbackLoading.value = false;
        playRequested.value = false;
        isPlaying.value = false;
        playbackError.value = 'The video stream stopped unexpectedly. Please retry.';
      }
    });
    hls.attachMedia(video.value);
    hls.loadSource(source);
    return;
  }
  if (video.value.canPlayType('application/vnd.apple.mpegurl')) {
    void inspectQualityLevels(source);
    nativeHlsPlayback = true;
    nativeQualityOnly.value = true;
    video.value.src = source;
    video.value.load();
    return;
  }
  throw new Error('HLS playback is not supported');
};
const loadOriginalSource = (source: string, restoreAt: number, shouldPlay: boolean) => {
  const media = video.value;
  if (!media) return;
  activeSourceUrl.value = source;
  sourceTransition.value = true;
  playbackReady.value = false;
  firstFrameReady.value = false;
  if (shouldPlay || !started.value) playbackLoading.value = true;
  if (sourceTransitionTimer) clearTimeout(sourceTransitionTimer);
  sourceTransitionTimer = setTimeout(() => { sourceTransition.value = false; }, 3_000);
  bufferedSegments.value = [];
  hls?.destroy();
  hls = undefined;
  nativeHlsPlayback = false;
  nativeQualityOnly.value = false;
  originalPlayback.value = true;
  const restore = () => {
    if (restoreAt > 0 && restoreAt < (media.duration || Infinity) - 3) media.currentTime = restoreAt;
    snapshotPlayback();
    if (shouldPlay) void media.play().catch(() => undefined);
    sourceTransition.value = false;
    if (sourceTransitionTimer) clearTimeout(sourceTransitionTimer);
    media.removeEventListener('loadedmetadata', restore);
  };
  media.addEventListener('loadedmetadata', restore);
  media.src = source;
  media.load();
};
const loadPreferredSource = (restoreAt: number, shouldPlay: boolean) => {
  if (directMp4.value || (qualityPreference.value === 'original' && canUseOriginalSource.value)) {
    loadOriginalSource(originalUrl.value, restoreAt, shouldPlay);
  } else if (signedUrl.value) {
    loadSource(signedUrl.value, restoreAt, shouldPlay);
  }
};
const authorize = async (renew = false) => {
  if (!series.value || !currentEpisode.value) return;
  // A tap can arrive while the eager grant request is still in flight. Wait
  // for that request instead of dropping the tap and making the user retry.
  while (renewing.value) await new Promise((resolve) => window.setTimeout(resolve, 25));
  renewing.value = true;
  try {
    const oldTime = video.value?.currentTime || currentTime.value;
    const wasPlaying = isPlaying.value;
    const prefetchedGrant = !renew ? initialGrantPromise : undefined;
    initialGrantPromise = undefined;
    const authorization = await (prefetchedGrant || api.getPlayback(series.value.id, currentEpisode.value.episodeNo, session(), { profile: playbackProfile() }));
    if (!authorization.signedUrl) throw new Error('No playable source');
    signedUrl.value = authorization.signedUrl;
    originalUrl.value = authorization.originalUrl || '';
    directMp4.value = authorization.delivery === 'mp4';
    rendition.value = authorization.rendition || 'original';
    if (directMp4.value) { qualityPreference.value = 'original'; qualityLevels.value = []; }
    else if (!renew) qualityPreference.value = 'auto';
    trackingToken.value = authorization.trackingToken;
    expiresAt.value = Date.parse(authorization.expiresAt || '') || Date.now() + 9 * 60_000;
    if (!renew && !started.value && !resumePromptResolved.value) {
      resumePosition.value = authorization.resumePositionSeconds || 0;
      resumeFallbackAttempted.value = false;
      currentTime.value = resumePosition.value;
      durationSeconds.value = authorization.resumeDurationSeconds || durationSeconds.value;
      progress.value = durationSeconds.value ? Math.min(100, currentTime.value / durationSeconds.value * 100) : 0;
    }
    const hasMeaningfulResume = resumePosition.value > 0;
    if (!renew && !started.value && !resumePromptResolved.value && hasMeaningfulResume) {
      playbackError.value = '';
      playbackLoading.value = false;
      playRequested.value = false;
      resumePromptPosition.value = resumePosition.value;
      resumePromptDuration.value = durationSeconds.value;
      showResumePrompt.value = true;
      scheduleRenewal();
      return;
    }
    if (video.value) {
      const restoreAt = !renew && !resumePromptResolved.value && resumePosition.value > 0 ? resumePosition.value : oldTime;
      loadPreferredSource(restoreAt, renew && wasPlaying);
      // Match fast-start players: expose the play control as soon as the grant
      // arrives while HLS continues pre-buffering its first segments.
      if (!renew && !playRequested.value) playbackLoading.value = false;
    }
    playbackError.value = '';
    scheduleRenewal();
  } catch {
    playbackError.value = 'This stream could not be loaded. Check your connection and try again.';
    isPlaying.value = false;
    playRequested.value = false;
    playbackLoading.value = false;
  } finally { renewing.value = false; }
};

const togglePlayback = async () => {
  if (!video.value || !canPlay.value || showResumePrompt.value) return;
  if (!video.value.paused && !playRequested.value) {
    video.value.pause();
    playbackLoading.value = false;
    return;
  }

  // Keep the user's play intent while the grant or first HLS segment is loading.
  // The canplay handler will start the element as soon as the browser has data.
  playRequested.value = true;
  playbackLoading.value = true;
  if (!signedUrl.value) {
    while (renewing.value) await new Promise((resolve) => window.setTimeout(resolve, 25));
    if (!signedUrl.value) await authorize();
  }
  await startPlaybackWhenReady();
};
const startPlaybackWhenReady = async () => {
  const media = video.value;
  if (!media || !signedUrl.value || playbackError.value || showResumePrompt.value || !playRequested.value) return;
  if (!playbackReady.value) return;
  if (media.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) return;
  try {
    await media.play();
    playRequested.value = false;
    playbackLoading.value = false;
  } catch (error) {
    // A source can still be swapping in after `canplay`; leave the intent queued
    // for the next readiness event instead of showing a false error.
    const name = error instanceof DOMException ? error.name : '';
    if (name === 'NotAllowedError' || name === 'AbortError') {
      playRequested.value = false;
      playbackLoading.value = false;
      playbackError.value = name === 'NotAllowedError' ? 'Tap play again to start this episode.' : '';
    } else {
      playRequested.value = false;
      playbackLoading.value = false;
      playbackError.value = 'Tap retry to start this episode.';
    }
  }
};
const onPlay = () => {
  isPlaying.value = true;
  playbackLoading.value = false;
  playRequested.value = false;
  snapshotPlayback();
  if (!started.value) playbackStartedAt.value = performance.now();
};
const onPause = () => {
  isPlaying.value = false;
  playbackLoading.value = false;
  stalled.value = false;
  if (started.value && !video.value?.ended) void record('heartbeat');
};
const maybePrefetchNext = () => {
  const media = video.value;
  if (nextPrefetchAttempted || !series.value || !media || media.paused
    || stalled.value || !canPrefetchPlayback() || currentTime.value < 5
    || durationSeconds.value - currentTime.value > 30) return;
  const next = series.value.episodes.find(item => item.episodeNo === episodeNo.value + 1);
  if (!next || (!next.isFree && !next.isUnlocked && !locallyUnlocked.value)) return;
  // Only speculate once the current episode has enough data to keep playing.
  let ahead = 0;
  for (let i = 0; i < media.buffered.length; i++) {
    if (media.buffered.start(i) <= media.currentTime && media.buffered.end(i) > media.currentTime) {
      ahead = media.buffered.end(i) - media.currentTime;
    }
  }
  if (ahead < Math.min(8, Math.max(0, durationSeconds.value - currentTime.value - 0.5))) return;
  nextPrefetchAttempted = true;
  const controller = new AbortController();
  nextPrefetchController = controller;
  const nextSessionId = crypto.randomUUID();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  void (async () => {
    try {
      const grant = await api.getPlayback(series.value!.id, next.episodeNo, nextSessionId,
        { profile: playbackProfile(), prewarm: true, signal: controller.signal });
      if (controller.signal.aborted || !grant.signedUrl) return;
      prefetchedNext = { episodeNo: next.episodeNo, sessionId: nextSessionId, grant };
      // The client's edge may differ from the API server's edge. Warm this POP
      // with a bounded request and reuse the same signed URL on navigation.
      if (grant.delivery === 'hls') await prefetchHlsStart(grant, controller.signal);
      else await prefetchPlaybackStart(grant.signedUrl, controller.signal);
    } catch { /* Optional warming must never surface as a playback error. */ }
    finally { clearTimeout(timeout); if (nextPrefetchController === controller) nextPrefetchController = undefined; }
  })();
};
const onTimeUpdate = () => {
  if (!video.value) return;
  currentTime.value = video.value.currentTime;
  durationSeconds.value = Number.isFinite(video.value.duration) ? video.value.duration : durationSeconds.value;
  progress.value = durationSeconds.value ? Math.min(100, currentTime.value / durationSeconds.value * 100) : 0;
  updateBuffered();
  maybePrefetchNext();
  if (isPlaying.value && Date.now() - lastHeartbeat.value > 15_000) { lastHeartbeat.value = Date.now(); void record('heartbeat'); }
};
const onLoadedMetadata = () => { snapshotPlayback(); updateBuffered(); };
const onLoadedData = () => {
  firstFrameReady.value = true;
  if (!playRequested.value) playbackLoading.value = false;
};
const onCanPlay = () => {
  playbackReady.value = true;
  firstFrameReady.value = true;
  if (!playRequested.value) playbackLoading.value = false;
  void startPlaybackWhenReady();
};
const onProgress = () => { updateBuffered(); };
const onEmptied = () => { bufferedSegments.value = []; };
const onFirstFrame = () => {
  if (firstFrameTracked.value || !started.value || !series.value || !currentEpisode.value) return;
  firstFrameTracked.value = true;
  void track('playback_first_frame', { seriesId: series.value.id, seriesTitle: series.value.title, episodeNo: episodeNo.value, properties: { latencyMs: Math.max(0, Math.round(performance.now() - playbackStartedAt.value)) } });
};
const onWaiting = () => {
  stopNextPrefetch();
  const media = video.value;
  // `stalled` is a network resource hint, not proof that playback stopped.
  // Only show the overlay for a non-paused element that has actually run out
  // of future media data; the template intentionally does not bind `stalled`
  // to this handler.
  if (!started.value || stalled.value || !media || media.paused || media.readyState > HTMLMediaElement.HAVE_CURRENT_DATA) return;
  playbackLoading.value = true;
  stalled.value = true;
  void track('playback_stall', { seriesId: series.value?.id, seriesTitle: series.value?.title, episodeNo: episodeNo.value, positionSeconds: currentTime.value });
};
const onPlaying = () => {
  playbackLoading.value = false;
  playRequested.value = false;
  seeking.value = false;
  if (!started.value) {
    started.value = true; lastHeartbeat.value = Date.now();
    void record('start');
    void track(currentEpisode.value?.isFree ? 'preview_start' : 'playback_start', { seriesId: series.value?.id, seriesTitle: series.value?.title, episodeNo: episodeNo.value });
  }
  onFirstFrame();
  if (stalled.value) { stalled.value = false; void track('playback_resume', { seriesId: series.value?.id, seriesTitle: series.value?.title, episodeNo: episodeNo.value, positionSeconds: currentTime.value }); }
};
const onVideoError = () => {
  if ((sourceTransition.value || renewing.value) && !originalPlayback.value) return;
  const mediaErrorCode = video.value?.error?.code || 0;
  // Seeking and source replacement can cancel an obsolete media request. That
  // is expected browser behaviour and must not become a connection error.
  if (mediaErrorCode === MediaError.MEDIA_ERR_ABORTED) {
    playbackLoading.value = false;
    seeking.value = false;
    isPlaying.value = Boolean(video.value && !video.value.paused);
    return;
  }
  if (!directMp4.value && originalPlayback.value && signedUrl.value && !originalFallbackAttempted.value) {
    originalFallbackAttempted.value = true;
    // Keep the highest-quality preference even when manifest discovery has
    // not finished. Renewals must also keep using HLS after a source failure.
    qualityPreference.value = 'original';
    playbackError.value = '';
    loadSource(signedUrl.value, currentTime.value, isPlaying.value || playRequested.value);
    return;
  }
  const failedAfterSeek = Boolean(
    signedUrl.value
    && seekStartedAt
    && Date.now() - seekStartedAt <= seekRecoveryWindowMs,
  );
  if (failedAfterSeek && !seekRecoveryAttempted) {
    seekRecoveryAttempted = true;
    seeking.value = false;
    playbackError.value = '';
    playRequested.value = seekShouldResume;
    playbackLoading.value = seekShouldResume;
    stalled.value = false;
    loadSource(signedUrl.value, seekTargetSeconds, seekShouldResume);
    return;
  }
  // hls.js owns MediaSource recovery. Its fatal error handler below decides
  // whether to restart loading, recover the media element, or show the error.
  if (hls && !nativeHlsPlayback) return;
  playbackLoading.value = false;
  playRequested.value = false;
  // Some browsers cannot decode a resumed fMP4 fragment when playback starts
  // close to the end of a VOD. Retry once from the beginning before exposing
  // the connection error UI; subsequent failures still remain actionable.
  const effectiveDuration = Number.isFinite(durationSeconds.value) && durationSeconds.value > 0
    ? durationSeconds.value
    : (video.value && Number.isFinite(video.value.duration) && video.value.duration > 0 ? video.value.duration : 0);
  const nearEnd = effectiveDuration > 0 && currentTime.value >= Math.max(0, effectiveDuration - resumeFallbackWindowSeconds);
  if (signedUrl.value && nearEnd && !resumeFallbackAttempted.value) {
    resumeFallbackAttempted.value = true;
    playbackError.value = '';
    loadSource(signedUrl.value, 0, started.value);
    return;
  }
  playbackError.value = 'The video stream is unavailable. Please retry.';
  isPlaying.value = false;
  void track('playback_error', { seriesId: series.value?.id, seriesTitle: series.value?.title, episodeNo: episodeNo.value, positionSeconds: currentTime.value });
};
const onEnded = async () => {
  isPlaying.value = false; snapshotPlayback(); progress.value = 100; await record('complete');
  void track(currentEpisode.value?.isFree ? 'preview_complete' : 'playback_complete', { seriesId: series.value?.id, seriesTitle: series.value?.title, episodeNo: episodeNo.value, positionSeconds: currentTime.value, durationSeconds: durationSeconds.value });
};
const seek = (event: Event) => {
  const value = Number((event.target as HTMLInputElement).value);
  if (video.value && durationSeconds.value) {
    if (!seeking.value) {
      seekShouldResume = isPlaying.value || !video.value.paused;
      seekRecoveryAttempted = false;
    }
    seeking.value = true;
    seekStartedAt = Date.now();
    seekTargetSeconds = Math.max(0, Math.min(durationSeconds.value, value / 100 * durationSeconds.value));
    playbackError.value = '';
    stalled.value = false;
    video.value.currentTime = seekTargetSeconds;
    snapshotPlayback();
  }
};
const onSeeking = () => {
  seeking.value = true;
  playbackReady.value = false;
};
const onSeeked = () => {
  seeking.value = false;
  snapshotPlayback();
  updateBuffered();
  const media = video.value;
  playbackReady.value = Boolean(media && media.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA);
  if (seekShouldResume && media?.paused) {
    playRequested.value = true;
    playbackLoading.value = !playbackReady.value;
    void startPlaybackWhenReady();
  } else {
    playbackLoading.value = false;
  }
};
const persistSeek = () => {
  seekStartedAt = Date.now();
  if (started.value) void record('heartbeat');
};
const cycleSpeed = () => { const values = [1, 1.25, 1.5, 2]; speed.value = values[(values.indexOf(speed.value) + 1) % values.length] || 1; if (video.value) video.value.playbackRate = speed.value; };
const selectQuality = (value: string) => {
  qualityPreference.value = value === 'auto' || value === 'original'
    ? value
    : Math.max(0, Number(value.replace('resolution:', '')) || 0);
  snapshotPlayback();
  const shouldPlay = Boolean(video.value && !video.value.paused) || playRequested.value;
  if (qualityPreference.value === 'original' && originalUrl.value) {
    originalFallbackAttempted.value = false;
    loadOriginalSource(originalUrl.value, currentTime.value, shouldPlay);
    return;
  }
  if (!hls || originalPlayback.value) {
    if (signedUrl.value) loadSource(signedUrl.value, currentTime.value, shouldPlay);
    return;
  }
  const selectedLevel = resolveVideoQualityLevel(qualityLevels.value, qualityPreference.value);
  // `currentLevel` applies the rendition immediately. `nextLevel` alone only
  // schedules a future switch and can leave the current segment playing for
  // an indeterminate amount of time, which made the selector look cosmetic.
  sourceTransition.value = true;
  playbackLoading.value = true;
  if (sourceTransitionTimer) clearTimeout(sourceTransitionTimer);
  hls.currentLevel = selectedLevel;
  hls.loadLevel = selectedLevel;
  hls.nextLevel = selectedLevel;
  sourceTransitionTimer = setTimeout(() => {
    sourceTransition.value = false;
    playbackLoading.value = false;
  }, 1200);
};
const chooseQuality = (value: string) => {
  closeQualityDrawer();
  const next = value === 'auto' || value === 'original' ? value : Math.max(0, Number(value.replace('resolution:', '')) || 0);
  if (next === qualityPreference.value) {
    return;
  }
  selectQuality(typeof next === 'number' ? `resolution:${next}` : next);
};
const syncFullscreen = () => {
  const doc = document as FullscreenDocument;
  isFullscreen.value = Boolean(player.value && (doc.fullscreenElement || doc.webkitFullscreenElement) === player.value);
  showControls.value = true;
};
const fullscreen = async () => {
  if (!video.value || !player.value || fullscreenPending.value) return;
  fullscreenError.value = '';
  fullscreenPending.value = true;
  try {
    if (isFullscreen.value) await exitVideoFullscreen(document);
    else await enterVideoFullscreen(player.value, video.value);
  } catch {
    fullscreenError.value = 'Fullscreen could not open. Try again, or open this page in Safari or Chrome.';
  } finally {
    fullscreenPending.value = false;
  }
};
const returnToSeries = () => navigateTo(`/series/${String(route.params.slug)}`, { replace: true });
const nextEpisode = () => {
  if (!series.value || episodeNo.value >= series.value.episodeCount) return;
  const next = series.value.episodes[episodeNo.value];
  if (!next?.isUnlocked && !next?.isFree && !locallyUnlocked.value) { void track('lock_trigger', { seriesId: series.value.id, seriesTitle: series.value.title, episodeNo: episodeNo.value + 1, properties: { source: 'next_episode' } }); showUnlock.value = true; return; }
  void track('next_episode_click', { seriesId: series.value.id, seriesTitle: series.value.title, episodeNo: episodeNo.value + 1 });
  if (!video.value?.ended) void record('heartbeat');
  if (prefetchedNext?.episodeNo === episodeNo.value + 1) {
    handoffPlayback({ slug: series.value.slug, ...prefetchedNext });
  }
  navigateTo(`/watch/${series.value.slug}/${episodeNo.value + 1}`);
};
const retry = async () => { playbackError.value = ''; resumeFallbackAttempted.value = false; playRequested.value = true; playbackLoading.value = true; await authorize(); await startPlaybackWhenReady(); };
const requestRouteGrant = () => {
  if (initialGrantPromise || initialGrantRequested.value || signedUrl.value) return;
  const warm = takePlaybackHandoff(String(route.params.slug), episodeNo.value);
  if (warm) { sessionId.value = warm.sessionId; initialGrantPromise = Promise.resolve(warm.grant); }
  else initialGrantPromise = api.getPlaybackBySlug(String(route.params.slug), episodeNo.value, session(), { profile: playbackProfile() });
  // Locked or unavailable episodes are rendered from the series response; keep
  // speculative authorization failures from becoming unhandled rejections.
  void initialGrantPromise.catch(() => undefined);
};
const requestInitialGrant = () => {
  if (initialGrantRequested.value || !series.value || !currentEpisode.value || !canPlay.value) return;
  initialGrantRequested.value = true;
  playbackLoading.value = true;
  void authorize();
};
const trapResumePromptFocus = (event: KeyboardEvent) => {
  const first = resumeCloseButton.value;
  const last = resumeRestartButton.value;
  if (!first || !last) return;
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
};
const dismissResumePrompt = () => {
  if (resumePromptResolving.value || !signedUrl.value) return;
  resumePromptResolved.value = true;
  showResumePrompt.value = false;
  resumePosition.value = resumePromptPosition.value;
  currentTime.value = resumePosition.value;
  progress.value = resumePromptDuration.value ? Math.min(100, resumePosition.value / resumePromptDuration.value * 100) : 0;
  playRequested.value = false;
  loadPreferredSource(resumePosition.value, false);
  playbackLoading.value = false;
};
const chooseResume = (choice: 'resume' | 'restart') => {
  if (resumePromptResolving.value || !signedUrl.value) return;
  resumePromptResolving.value = true;
  resumePromptResolved.value = true;
  showResumePrompt.value = false;
  resumePosition.value = choice === 'resume' ? resumePromptPosition.value : 0;
  currentTime.value = resumePosition.value;
  progress.value = resumePromptDuration.value ? Math.min(100, resumePosition.value / resumePromptDuration.value * 100) : 0;
  playRequested.value = true;
  playbackLoading.value = true;
  try {
    const media = video.value;
    if (!media) throw new Error('Video element is unavailable');
    loadPreferredSource(resumePosition.value, false);
    // Start the play request inside the button's user gesture. The promise can
    // remain pending while HLS loads; `canplay` retries if a source swap aborts it.
    void media.play().catch((error) => {
      const name = error instanceof DOMException ? error.name : '';
      if (name === 'AbortError' || (!playbackReady.value && name === 'NotSupportedError')) return;
      playRequested.value = false;
      playbackLoading.value = false;
      playbackError.value = name === 'NotAllowedError'
        ? 'Tap play again to start this episode.'
        : 'Tap retry to start this episode.';
    });
  } catch {
    playRequested.value = false;
    playbackLoading.value = false;
    playbackError.value = 'This browser could not start the video stream. Please retry.';
  } finally {
    resumePromptResolving.value = false;
  }
};
const persistOnExit = () => { if (started.value && !video.value?.ended) void record('heartbeat', true); };
const persistWhenHidden = () => { if (document.visibilityState === 'hidden') { stopNextPrefetch(); persistOnExit(); } };
const handleUnlocked = async () => {
  locallyUnlocked.value = true;
  showUnlock.value = false;
  const slug = String(route.params.slug);
  invalidatePageDataCache(`series-${slug}`);
  initialGrantRequested.value = false;
  await refresh();
  // The video element is created by v-if after the unlock event.
  await nextTick();
  requestInitialGrant();
};

onMounted(() => {
  if (typeof PerformanceObserver !== 'undefined') {
    networkResourceObserver = new PerformanceObserver((list) => sampleNativeMediaTimings(list.getEntries()));
    try {
      networkResourceObserver.observe({ type: 'resource', buffered: true });
    } catch {
      networkResourceObserver.disconnect();
      networkResourceObserver = undefined;
    }
  }
  window.addEventListener('pagehide', persistOnExit);
  document.addEventListener('visibilitychange', persistWhenHidden);
  document.addEventListener('fullscreenchange', syncFullscreen);
  document.addEventListener('webkitfullscreenchange', syncFullscreen);
  requestRouteGrant();
  requestInitialGrant();
});
watch([canPlay, currentEpisode], requestInitialGrant, { flush: 'post' });
watch([video, signedUrl, originalUrl], () => {
  if (!video.value || !signedUrl.value || showResumePrompt.value || resumePromptResolving.value) return;
  const source = qualityPreference.value === 'original' && canUseOriginalSource.value ? originalUrl.value : signedUrl.value;
  if (activeSourceUrl.value === source) return;
  const restoreAt = !resumePromptResolved.value && resumePosition.value > 0 ? resumePosition.value : currentTime.value;
  loadPreferredSource(restoreAt, false);
});
watch(showResumePrompt, (open) => {
  if (open) void nextTick(() => resumeContinueButton.value?.focus());
});
onBeforeUnmount(() => {
  stopNextPrefetch();
  if (renewTimer) clearTimeout(renewTimer);
  if (sourceTransitionTimer) clearTimeout(sourceTransitionTimer);
  networkResourceObserver?.disconnect();
  window.removeEventListener('pagehide', persistOnExit);
  document.removeEventListener('visibilitychange', persistWhenHidden);
  document.removeEventListener('fullscreenchange', syncFullscreen);
  document.removeEventListener('webkitfullscreenchange', syncFullscreen);
  if (started.value && !video.value?.ended) void record('heartbeat', true);
  hls?.destroy();
});
</script>

<template>
  <main v-if="series && currentEpisode" ref="player" class="watch-page" @click="showControls = !showControls">
    <div class="watch-visual" :style="{ '--watch-image': `url(${series.backdropUrl})` }" />
    <video v-if="canPlay" ref="video" class="watch-video" :poster="series.backdropUrl" playsinline preload="auto" @click.stop @play="onPlay" @playing="onPlaying" @canplay="onCanPlay" @loadeddata="onLoadedData" @waiting="onWaiting" @pause="onPause" @seeking="onSeeking" @seeked="onSeeked" @timeupdate="onTimeUpdate" @loadedmetadata="onLoadedMetadata" @durationchange="onLoadedMetadata" @progress="onProgress" @emptied="onEmptied" @ended="onEnded" @error="onVideoError" />
    <div class="watch-vignette" />
    <Transition name="fade"><div v-if="showControls" class="watch-top" @click.stop><button type="button" aria-label="Go back" @click="goBack"><ArrowLeft :size="22" /></button><div><strong>{{ series.title }}</strong><span>Episode {{ episodeNo }} · {{ currentEpisode.title }}</span></div></div></Transition>
    <div v-if="canPlay && playbackLoading && !playbackError && !showResumePrompt" class="watch-loading-overlay" role="status" aria-live="polite" aria-busy="true" @click.stop>
      <div class="watch-loading-overlay__content">
        <Loader2 class="watch-loading-overlay__spinner" :size="34" aria-hidden="true" />
        <strong>{{ playbackLoadingLabel }}</strong>
        <span>{{ networkDetailLabel }}</span>
      </div>
    </div>
    <button v-if="canPlay && signedUrl && !playbackError && !playbackLoading && !showResumePrompt" class="watch-center" type="button" :aria-label="isPlaying ? 'Pause' : 'Play'" @click.stop="togglePlayback"><Pause v-if="isPlaying" :size="32" fill="currentColor" /><Play v-else :size="34" fill="currentColor" /></button>
    <section v-if="!canPlay" class="watch-lock" @click.stop><span><LockKeyhole :size="28" /></span><p>Episode {{ episodeNo }} is locked</p><h1>{{ purchasable ? 'Keep the story going' : 'Episode unavailable' }}</h1><button v-if="purchasable" class="button button--primary button--wide" type="button" @click="track('lock_trigger', { seriesId: series.id, seriesTitle: series.title, episodeNo, properties: { source: 'watch_lock' } }); showUnlock = true">Unlock full series</button><button class="watch-lock__secondary" type="button" @click="returnToSeries">Choose another episode</button></section>
    <section v-if="playbackError" class="watch-lock" @click.stop><span><RotateCcw :size="27" /></span><h1>Connection interrupted</h1><p>{{ playbackError }}</p><button class="button button--primary" type="button" @click="retry">Retry playback</button></section>
    <Transition name="resume-modal"><div v-if="showResumePrompt" class="resume-modal-backdrop" @click.stop><section class="resume-modal" role="dialog" aria-modal="true" aria-labelledby="resume-modal-title" aria-describedby="resume-modal-copy" @click.stop @keydown.tab="trapResumePromptFocus" @keydown.esc="dismissResumePrompt"><button ref="resumeCloseButton" class="resume-modal__close" type="button" aria-label="Close continue watching dialog" title="Close" @click="dismissResumePrompt"><X :size="20" /></button><div class="resume-modal__icon"><History :size="22" /></div><p class="resume-modal__eyebrow">Welcome back</p><h2 id="resume-modal-title">Continue watching?</h2><p id="resume-modal-copy" class="resume-modal__copy">Pick up {{ series.title }} where you left off, or start this episode again.</p><div class="resume-modal__progress"><span>Episode {{ episodeNo }}</span><strong>{{ formatTime(resumePromptPosition) }} watched</strong></div><div class="resume-modal__actions"><button ref="resumeContinueButton" class="button button--primary button--wide" type="button" @click="chooseResume('resume')"><Play :size="17" fill="currentColor" />Continue from {{ formatTime(resumePromptPosition) }}</button><button ref="resumeRestartButton" class="button button--secondary button--wide" type="button" @click="chooseResume('restart')"><RotateCcw :size="17" />Start from beginning</button></div></section></div></Transition>
    <Transition name="fade"><div v-if="showControls && canPlay && signedUrl && !showResumePrompt" class="watch-bottom" @click.stop><p v-if="fullscreenError" class="watch-fullscreen-error" role="status">{{ fullscreenError }}</p><div class="watch-progress" :style="{ '--played-progress': `${progress}%` }"><div class="watch-progress__track" aria-hidden="true"><span v-for="(segment, index) in bufferedSegments" :key="index" class="watch-progress__buffered" :style="{ left: `${segment.left}%`, width: `${segment.width}%` }" /><i class="watch-progress__played" /></div><input class="watch-progress-input" type="range" min="0" max="100" step="0.1" :value="progress" :aria-valuetext="`${formatTime(currentTime)} of ${durationLabel}`" aria-label="Seek" @input="seek" @change="persistSeek" /></div><div class="watch-time"><span>{{ formatTime(currentTime) }}</span><span>{{ durationLabel }}</span></div><div class="watch-controls"><PlayerVolumeControl :media="video" /><button type="button" aria-label="Playback speed" @click="cycleSpeed"><Gauge :size="22" /><span>{{ speed }}×</span></button><button ref="qualityTrigger" type="button" class="watch-quality" :class="{ 'is-disabled': directMp4 || (!qualityLevels.length && !originalUrl) }" :disabled="directMp4 || (!qualityLevels.length && !originalUrl)" aria-label="Video quality" aria-haspopup="dialog" :aria-expanded="showQualityDrawer" @click="openQualityDrawer"><Settings2 :size="21" aria-hidden="true" /><span>{{ qualityControlLabel }}</span></button><button type="button" :aria-label="isFullscreen ? 'Exit fullscreen' : 'Fullscreen'" :disabled="fullscreenPending" @click="fullscreen"><Minimize2 v-if="isFullscreen" :size="21" /><Maximize2 v-else :size="21" /></button><button type="button" aria-label="Next episode" @click="nextEpisode"><SkipForward :size="22" /><span>Next</span></button></div><button v-if="episodeNo < series.episodeCount" class="up-next" type="button" @click="nextEpisode"><span>UP NEXT</span><strong>Episode {{ episodeNo + 1 }}</strong><ChevronRight :size="20" /></button></div></Transition>
    <Transition name="sheet">
      <div v-if="showQualityDrawer" class="quality-drawer-backdrop" @click.stop="closeQualityDrawer">
        <section ref="qualityDrawer" class="quality-drawer" role="dialog" aria-modal="true" aria-labelledby="quality-drawer-title" @click.stop @keydown.esc.stop="closeQualityDrawer" @keydown.tab="trapQualityFocus">
          <header><h2 id="quality-drawer-title">Video quality</h2><button type="button" aria-label="Close quality selector" @click="closeQualityDrawer"><X :size="20" /></button></header>
          <p v-if="nativeQualityOnly" class="quality-drawer-note">Your browser adjusts stream quality automatically.</p>
          <div class="quality-options">
            <button v-for="option in qualityOptions" :key="option.value" type="button" :aria-pressed="qualitySelectValue === option.value" :class="{ 'is-selected': qualitySelectValue === option.value }" @click="chooseQuality(option.value)">
              <span>{{ option.label }}</span><small>{{ option.detail }}</small><Check v-if="qualitySelectValue === option.value" :size="20" aria-hidden="true" />
            </button>
          </div>
        </section>
      </div>
    </Transition>
    <UnlockSheet v-if="purchasable" :series="series" :open="showUnlock" @close="showUnlock = false" @unlocked="handleUnlocked" />
  </main>
  <main v-else class="watch-page watch-page--loading" :aria-busy="status === 'pending'">
    <Loader2 v-if="status === 'pending'" class="watch-loading-overlay__spinner" :size="34" aria-hidden="true" />
    <span>{{ status === 'pending' ? 'Preparing episode…' : 'Episode unavailable' }}</span>
  </main>
</template>
