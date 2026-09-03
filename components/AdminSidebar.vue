<script setup lang="ts">
import {
  BarChart3,
  ChevronDown,
  Clapperboard,
  CreditCard,
  Film,
  Gauge,
  Globe2,
  LayoutGrid,
  Settings,
  ShieldCheck,
  Tags,
  UserCog,
  Users,
  X,
} from 'lucide-vue-next';
import type { AdminPermission } from '~/shared/admin-rbac';

defineProps<{ mobileOpen: boolean }>();
const emit = defineEmits<{ 'update:mobileOpen': [value: boolean] }>();
const route = useRoute();
const collapsed = useState('admin-sidebar-collapsed', () => false);
const { can } = useAdminAuth();

const menuGroups = computed(() => ([
  { label: '工作台', items: [{ label: '数据概览', to: '/admin', icon: Gauge, permission: 'dashboard.read' as AdminPermission }] },
  {
    label: '内容运营',
    items: [
      { label: '短剧管理', to: '/admin/series', icon: Film, permission: 'content.read' as AdminPermission },
      { label: '首页配置', to: '/admin/operations', icon: LayoutGrid, permission: 'content.read' as AdminPermission },
      { label: '分类与标签', to: '/admin/taxonomy', icon: Tags, permission: 'content.read' as AdminPermission },
    ],
  },
  {
    label: '交易与用户',
    items: [
      { label: '订单管理', to: '/admin/orders', icon: CreditCard, permission: 'finance.read' as AdminPermission },
      { label: '用户与权益', to: '/admin/users', icon: Users, permission: 'finance.read' as AdminPermission },
      { label: '对账中心', to: '/admin/reconciliation', icon: BarChart3, permission: 'finance.read' as AdminPermission },
    ],
  },
  {
    label: '系统',
    items: [
      { label: '管理员账号', to: '/admin/administrators', icon: UserCog, permission: 'administrators.manage' as AdminPermission },
      { label: '站点与支付', to: '/admin/system', icon: Settings, permission: 'system.read' as AdminPermission },
      { label: '域名管理', to: '/admin/domains', icon: Globe2, permission: 'domains.manage' as AdminPermission },
      { label: '审计日志', to: '/admin/audit', icon: ShieldCheck, permission: 'audit.read' as AdminPermission },
    ],
  },
]).map((group) => ({ ...group, items: group.items.filter((item) => can(item.permission)) })).filter((group) => group.items.length));

const active = (to: string) => to === '/admin'
  ? route.path === to || route.path.startsWith('/admin/metrics/')
  : route.path.startsWith(to);
const closeMobile = () => emit('update:mobileOpen', false);
</script>

<template>
  <div v-if="mobileOpen" class="admin-sidebar-mask" @click="closeMobile" />
  <aside class="admin-sidebar" :class="{ 'is-mobile-open': mobileOpen }">
    <div class="admin-brand">
      <span class="admin-brand__mark"><Clapperboard :size="19" /></span>
      <strong v-show="!collapsed">ReelNova Admin</strong>
      <button class="admin-mobile-close" type="button" aria-label="关闭菜单" @click="closeMobile"><X :size="20" /></button>
    </div>
    <nav class="admin-menu" aria-label="后台菜单">
      <section v-for="group in menuGroups" :key="group.label" class="admin-menu__group">
        <h2 v-show="!collapsed">{{ group.label }}</h2>
        <NuxtLink
          v-for="item in group.items"
          :key="item.to"
          :to="item.to"
          class="admin-menu__item"
          :class="{ 'is-active': active(item.to) }"
          :title="collapsed ? item.label : undefined"
          @click="closeMobile"
        >
          <component :is="item.icon" :size="18" />
          <span v-show="!collapsed">{{ item.label }}</span>
        </NuxtLink>
      </section>
    </nav>
    <NuxtLink v-if="can('system.read')" v-show="!collapsed" to="/admin/system" class="admin-sidebar__footer">
      <span class="status-dot info" />
      <div><strong>Cloudflare</strong><span>D1 + PayPal data source</span></div>
      <ChevronDown :size="16" />
    </NuxtLink>
  </aside>
</template>
