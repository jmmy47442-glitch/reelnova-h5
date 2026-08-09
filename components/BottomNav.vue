<script setup lang="ts">
import { Compass, Home, Library, UserRound } from 'lucide-vue-next';

const route = useRoute();
const navItems = [
  { label: 'Home', to: '/', icon: Home },
  { label: 'Explore', to: '/explore', icon: Compass },
  { label: 'Library', to: '/library', icon: Library },
  { label: 'Profile', to: '/profile', icon: UserRound },
];

const isActive = (path: string) => path === '/' ? route.path === '/' : route.path.startsWith(path);
</script>

<template>
  <nav class="bottom-nav" aria-label="Primary navigation">
    <NuxtLink
      v-for="item in navItems"
      :key="item.to"
      :to="item.to"
      class="bottom-nav__item"
      :class="{ 'is-active': isActive(item.to) }"
    >
      <span class="bottom-nav__icon"><component :is="item.icon" :size="22" :stroke-width="2.2" /></span>
      <span>{{ item.label }}</span>
    </NuxtLink>
  </nav>
</template>
