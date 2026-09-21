<script setup lang="ts">
const route = useRoute();

// The public entry point is the home feed. Keep the sign-in form available
// when a protected page explicitly sends the user here with a return path,
// but do not make a bare `/login` visit the first screen of the app.
if (!route.query.redirect && !route.query.accountDeleted) {
  await navigateTo('/', { replace: true });
}

definePageMeta({ layout: false });
useHead({ title: 'Sign in · ReelNova' });
</script>

<template><UserAuthForm mode="login" /></template>
