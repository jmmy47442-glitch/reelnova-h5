<script setup lang="ts">
import { Volume2, VolumeX } from 'lucide-vue-next';

const props = defineProps<{ media: HTMLVideoElement | null }>();
const root = ref<HTMLElement | null>(null);
const trigger = ref<HTMLButtonElement | null>(null);
const open = ref(false);
const volume = ref(1);
const muted = ref(false);
const deviceVolumeOnly = ref(false);
const percent = computed(() => Math.round((muted.value ? 0 : volume.value) * 100));
let previousVolume = 1;
let pointerId: number | null = null;
let startY = 0;
let startVolume = 1;
let dragged = false;

const syncVolume = () => {
  if (!props.media) return;
  volume.value = props.media.volume;
  muted.value = props.media.muted;
};
watch(() => props.media, (media, previous) => {
  previous?.removeEventListener('volumechange', syncVolume);
  media?.addEventListener('volumechange', syncVolume);
  deviceVolumeOnly.value = false;
  syncVolume();
}, { immediate: true });

const setVolume = (value: number) => {
  const media = props.media;
  if (!media) return;
  const next = Math.max(0, Math.min(1, value));
  if (next === 0) {
    if (media.volume > 0) previousVolume = media.volume;
    media.muted = true;
  } else {
    media.muted = false;
    try { media.volume = next; } catch { deviceVolumeOnly.value = true; }
    // iOS can reserve volume for hardware controls. Never display a fake level.
    if (Math.abs(media.volume - next) > 0.01) deviceVolumeOnly.value = true;
  }
  syncVolume();
};
const toggleMute = () => {
  const media = props.media;
  if (!media) return;
  if (muted.value || volume.value === 0) setVolume(volume.value || previousVolume);
  else { previousVolume = volume.value; media.muted = true; syncVolume(); }
};
const onPointerDown = (event: PointerEvent) => {
  if (!event.isPrimary || event.button !== 0) return;
  pointerId = event.pointerId;
  startY = event.clientY;
  startVolume = muted.value ? 0 : volume.value;
  dragged = false;
  trigger.value?.setPointerCapture(event.pointerId);
};
const onPointerMove = (event: PointerEvent) => {
  if (pointerId !== event.pointerId) return;
  const delta = startY - event.clientY;
  if (!dragged && Math.abs(delta) < 5) return;
  dragged = true;
  open.value = true;
  if (!deviceVolumeOnly.value) setVolume(startVolume + delta / 140);
};
const onPointerEnd = (event: PointerEvent) => {
  if (pointerId !== event.pointerId) return;
  pointerId = null;
  if (trigger.value?.hasPointerCapture(event.pointerId)) trigger.value.releasePointerCapture(event.pointerId);
};
const toggleOpen = (event: MouseEvent) => {
  if (dragged && event.detail !== 0) { dragged = false; return; }
  open.value = !open.value;
};
const closeOutside = (event: PointerEvent) => {
  if (event.target instanceof Node && !root.value?.contains(event.target)) open.value = false;
};
const onEscape = (event: KeyboardEvent) => {
  if (event.key !== 'Escape' || !open.value) return;
  open.value = false;
  trigger.value?.focus();
};
onMounted(() => {
  document.addEventListener('pointerdown', closeOutside);
  document.addEventListener('keydown', onEscape);
});
onBeforeUnmount(() => {
  props.media?.removeEventListener('volumechange', syncVolume);
  document.removeEventListener('pointerdown', closeOutside);
  document.removeEventListener('keydown', onEscape);
});
</script>

<template>
  <div ref="root" class="watch-volume" @click.stop>
    <div v-if="open" class="watch-volume__panel" role="group" aria-label="Volume controls">
      <output class="watch-volume__value" aria-live="polite">{{ deviceVolumeOnly ? (muted ? 'Muted' : 'Sound on') : `${percent}%` }}</output>
      <input v-if="!deviceVolumeOnly" class="watch-volume__slider" type="range" min="0" max="100" step="1" :value="percent" aria-label="Volume" aria-orientation="vertical" :aria-valuetext="`${percent}%`" @input="setVolume(Number(($event.target as HTMLInputElement).value) / 100)" />
      <p v-else class="watch-volume__hint" role="status">Use your device volume buttons to adjust the sound.</p>
      <button type="button" :aria-label="muted || volume === 0 ? 'Unmute' : 'Mute'" @click="toggleMute"><VolumeX v-if="muted || volume === 0" :size="20" /><Volume2 v-else :size="20" /></button>
    </div>
    <button ref="trigger" type="button" class="watch-volume__trigger" aria-label="Volume controls" :aria-expanded="open" title="Volume: drag up or down" @click="toggleOpen" @pointerdown="onPointerDown" @pointermove="onPointerMove" @pointerup="onPointerEnd" @pointercancel="onPointerEnd" @lostpointercapture="onPointerEnd">
      <VolumeX v-if="muted || volume === 0" :size="21" /><Volume2 v-else :size="21" />
    </button>
  </div>
</template>

<style scoped>
.watch-volume { position: relative; }
.watch-volume__trigger { touch-action: none; user-select: none; -webkit-user-select: none; }
.watch-volume__panel { position: absolute; z-index: 5; bottom: calc(100% + 12px); left: 0; display: flex; width: 76px; padding: 12px 8px 4px; border: 1px solid rgba(255,255,255,.18); border-radius: 12px; background: rgba(16,16,20,.96); box-shadow: 0 8px 30px rgba(0,0,0,.35); align-items: center; flex-direction: column; gap: 10px; }
.watch-volume__value { font-size: 12px; font-variant-numeric: tabular-nums; }
.watch-volume__slider { width: 44px; height: min(140px, 25dvh); margin: 0; writing-mode: vertical-lr; direction: rtl; accent-color: var(--signal, #ff3d79); cursor: pointer; touch-action: none; }
.watch-volume__panel:has(.watch-volume__hint) { width: 180px; }
.watch-volume__hint { margin: 0; font-size: 12px; line-height: 1.5; text-align: center; }
.watch-volume button:focus-visible, .watch-volume__slider:focus-visible { outline: 2px solid #fff; outline-offset: 3px; }
</style>
