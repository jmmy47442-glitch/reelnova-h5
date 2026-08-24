<script setup lang="ts">
import { LoaderCircle } from 'lucide-vue-next';

const route = useRoute();
const nuxtApp = useNuxtApp();
const visible = ref(false);
let startedAt = 0;
let hideTimer: ReturnType<typeof setTimeout> | undefined;

const start = () => {
  if (hideTimer) clearTimeout(hideTimer);
  startedAt = performance.now();
  visible.value = true;
};

const finish = () => {
  const elapsed = performance.now() - startedAt;
  hideTimer = setTimeout(() => {
    visible.value = false;
  }, Math.max(0, 160 - elapsed));
};

const removeStartHook = nuxtApp.hook('page:start', start);
const removeFinishHook = nuxtApp.hook('page:finish', finish);
const removeErrorHook = nuxtApp.hook('vue:error', finish);

onBeforeUnmount(() => {
  if (hideTimer) clearTimeout(hideTimer);
  removeStartHook();
  removeFinishHook();
  removeErrorHook();
});
</script>

<template>
  <Transition name="route-loading">
    <div
      v-if="visible"
      class="route-loading-overlay"
      :class="{ 'route-loading-overlay--admin': route.path.startsWith('/admin') }"
      role="status"
      aria-live="polite"
      aria-label="页面加载中"
    >
      <span class="route-loading-overlay__content">
        <LoaderCircle :size="17" aria-hidden="true" />
        <span>{{ route.path.startsWith('/admin') ? '页面加载中' : 'Loading' }}</span>
      </span>
    </div>
  </Transition>
</template>
