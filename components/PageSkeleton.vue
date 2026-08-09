<template>
  <div class="skeleton-page" aria-label="Loading content" aria-busy="true">
    <div class="skeleton skeleton--title" />
    <div class="poster-grid">
      <div v-for="item in 9" :key="item">
        <div class="skeleton skeleton--poster" />
        <div class="skeleton skeleton--line" />
      </div>
    </div>
  </div>
</template>
