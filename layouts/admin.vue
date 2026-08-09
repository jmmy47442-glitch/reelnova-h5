<script setup lang="ts">
const collapsed = useState('admin-sidebar-collapsed', () => false);
const mobileMenuOpen = useState('admin-mobile-menu', () => false);
</script>

<template>
  <div class="admin-app" :class="{ 'sidebar-collapsed': collapsed }">
    <AdminSidebar v-model:mobile-open="mobileMenuOpen" />
    <div class="admin-main">
      <AdminHeader @toggle-sidebar="collapsed = !collapsed" @open-mobile="mobileMenuOpen = true" />
      <AdminTabs />
      <main class="admin-content">
        <slot />
      </main>
    </div>
  </div>
</template>
