<script setup lang="ts">
const route = useRoute();
const primaryRoutes = new Set(['/', '/explore', '/library', '/profile']);
const showBottomNav = computed(() => primaryRoutes.has(route.path));
</script>

<template>
  <div class="app-shell">
    <main class="page-shell" :class="{ 'page-shell--without-nav': !showBottomNav }">
      <slot />
    </main>
    <BottomNav v-if="showBottomNav" />
  </div>
</template>
