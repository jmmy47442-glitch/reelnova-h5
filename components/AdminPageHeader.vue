<script setup lang="ts">
defineProps<{ title: string; description: string }>();
</script>

<template>
  <div class="admin-page-header">
    <div><h1>{{ title }}</h1><p>{{ description }}</p></div>
    <div class="admin-page-header__actions"><slot /></div>
  </div>
</template>
