<script setup lang="ts">
import { Bell, ChevronDown, LogOut, Menu, PanelLeftClose, Search } from 'lucide-vue-next';
import { ElMessage } from 'element-plus';
import type { AdminPendingItem } from '~/types/admin';

defineEmits<{ 'toggle-sidebar': []; 'open-mobile': [] }>();
const searchOpen = ref(false);
const query = ref('');
const { user, isSuperAdmin, logout } = useAdminAuth();
const api = useAdminApi();
const pendingItems = ref<AdminPendingItem[]>([]);
const pendingLoading = ref(false);
const pendingError = ref(false);
let pendingRefreshTimer: number | undefined;
const commands = [
  { label: '数据概览', description: '播放、收入与系统健康', to: '/admin' },
  { label: '短剧管理', description: '内容资料、分集与发布', to: '/admin/series' },
  { label: '首页配置', description: '分区排序与推荐内容', to: '/admin/operations' },
  { label: '分类与标签', description: '分类、多语言与标签', to: '/admin/taxonomy' },
  { label: '订单管理', description: '支付、退款与权益发放', to: '/admin/orders' },
  { label: '用户与权益', description: '用户、设备与补发权益', to: '/admin/users' },
  { label: '对账中心', description: '收入、手续费与异常', to: '/admin/reconciliation' },
  { label: '站点与支付', description: 'PayPal 与业务规则', to: '/admin/system' },
  { label: '域名管理', description: 'DNS、HTTPS 与跳转', to: '/admin/domains' },
  { label: '审计日志', description: '高风险操作记录', to: '/admin/audit' },
];
const availableCommands = computed(() => isSuperAdmin.value
  ? [...commands, { label: '管理员账号', description: '创建、停用和恢复管理员', to: '/admin/administrators' }]
  : commands);
const filtered = computed(() => availableCommands.value.filter((item) => `${item.label} ${item.description}`.toLowerCase().includes(query.value.toLowerCase())));
const openCommand = () => { searchOpen.value = true; nextTick(() => document.querySelector<HTMLInputElement>('.command-search input')?.focus()); };
const go = (to: string) => { searchOpen.value = false; query.value = ''; navigateTo(to); };
const loadPendingItems = async () => {
  if (pendingLoading.value) return;
  pendingLoading.value = true;
  pendingError.value = false;
  try {
    const response = await api.getPendingItems();
    pendingItems.value = response.items;
  } catch {
    pendingItems.value = [];
    pendingError.value = true;
  } finally {
    pendingLoading.value = false;
  }
};
const handleCommand = async (command: string) => {
  if (command === 'audit') return go('/admin/audit');
  if (command === 'administrators') return go('/admin/administrators');
  if (command === 'logout') {
    await logout();
    await navigateTo('/admin/login');
    ElMessage.success('已退出登录');
    return;
  }
  ElMessage.info('当前为演示管理员会话');
};
const onKeydown = (event: KeyboardEvent) => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); openCommand(); } };
onMounted(() => {
  window.addEventListener('keydown', onKeydown);
  void loadPendingItems();
  pendingRefreshTimer = window.setInterval(() => void loadPendingItems(), 60_000);
});
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown);
  if (pendingRefreshTimer) window.clearInterval(pendingRefreshTimer);
});
</script>

<template>
  <header class="admin-header">
    <div class="admin-header__start">
      <button class="admin-icon-button desktop-only" type="button" title="折叠侧栏" @click="$emit('toggle-sidebar')"><PanelLeftClose :size="19" /></button>
      <button class="admin-icon-button mobile-only" type="button" aria-label="打开菜单" @click="$emit('open-mobile')"><Menu :size="20" /></button>
      <button class="admin-search" type="button" @click="openCommand"><Search :size="17" /><span>搜索菜单或功能</span><kbd>⌘ K</kbd></button>
    </div>
    <div class="admin-header__end">
      <el-popover placement="bottom-end" :width="300" trigger="click" @show="loadPendingItems"><template #reference><button class="admin-icon-button" :class="{ 'has-notice': pendingItems.length > 0 }" type="button" title="通知"><Bell :size="19" /></button></template><div class="notification-list"><strong>待处理事项</strong><div v-if="pendingLoading" class="notification-list__state">正在读取最新待办...</div><div v-else-if="pendingError" class="notification-list__state notification-list__state--error">暂时无法读取真实待办，请稍后重试。</div><div v-else-if="!pendingItems.length" class="notification-list__state">暂无待处理事项</div><template v-else><button v-for="item in pendingItems" :key="item.id" type="button" @click="go(item.to)"><span class="health-dot" :class="item.severity" /><div><b>{{ item.count }} {{ item.title }}</b><small>{{ item.description }}</small></div></button></template></div></el-popover>
      <span class="admin-divider" />
      <el-dropdown @command="handleCommand"><button class="admin-user" type="button"><span class="admin-avatar">{{ user.name.slice(0, 2).toUpperCase() }}</span><span class="admin-user__copy"><strong>{{ user.name }}</strong><small>{{ isSuperAdmin ? '超级管理员' : user.email }}</small></span><ChevronDown :size="15" /></button><template #dropdown><el-dropdown-menu><el-dropdown-item v-if="isSuperAdmin" command="administrators">管理员账号</el-dropdown-item><el-dropdown-item command="audit">我的操作日志</el-dropdown-item><el-dropdown-item command="session" divided>会话信息</el-dropdown-item><el-dropdown-item command="logout"><LogOut :size="14" />退出登录</el-dropdown-item></el-dropdown-menu></template></el-dropdown>
    </div>
  </header>

  <el-dialog v-model="searchOpen" title="快速导航" width="min(560px, 92vw)" class="command-dialog"><el-input v-model="query" class="command-search" clearable placeholder="输入模块名称或功能"><template #prefix><Search :size="17" /></template></el-input><div class="command-list"><button v-for="item in filtered" :key="item.to" type="button" @click="go(item.to)"><strong>{{ item.label }}</strong><span>{{ item.description }}</span></button><p v-if="!filtered.length">没有匹配的功能</p></div></el-dialog>
</template>
