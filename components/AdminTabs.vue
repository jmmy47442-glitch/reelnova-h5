<script setup lang="ts">
import { ChevronDown, RotateCw, X } from 'lucide-vue-next';

const route = useRoute();
const { landingPath } = useAdminAuth();
const labels: Record<string, string> = {
  '/admin': '数据概览',
  '/admin/series': '短剧管理',
  '/admin/orders': '订单管理',
  '/admin/operations': '首页配置',
  '/admin/system': '站点与支付',
  '/admin/taxonomy': '分类与标签',
  '/admin/users': '用户与权益',
  '/admin/reconciliation': '对账中心',
  '/admin/domains': '域名管理',
  '/admin/audit': '审计日志',
  '/admin/administrators': '管理员账号',
};
const currentLabel = computed(() => labels[route.path] || '管理页面');
const refresh = () => window.location.reload();
</script>

<template>
  <div class="admin-tabs">
    <NuxtLink :to="landingPath" class="admin-tab" :class="{ 'is-active': route.path === landingPath }">首页</NuxtLink>
    <span v-if="route.path !== landingPath" class="admin-tab is-active">{{ currentLabel }} <button type="button" title="关闭页签" @click="navigateTo(landingPath)"><X :size="13" /></button></span>
    <div class="admin-tabs__tools">
      <button type="button" title="刷新" @click="refresh"><RotateCw :size="15" /></button>
      <button type="button" title="页签菜单"><ChevronDown :size="15" /></button>
    </div>
  </div>
</template>
