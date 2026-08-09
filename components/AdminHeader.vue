<script setup lang="ts">
import { Bell, ChevronDown, Menu, PanelLeftClose, Search } from 'lucide-vue-next';
import { ElMessage } from 'element-plus';

defineEmits<{ 'toggle-sidebar': []; 'open-mobile': [] }>();
const searchOpen = ref(false);
const query = ref('');
const commands = [
  { label: '数据概览', description: '播放、收入与系统健康', to: '/admin' },
  { label: '短剧管理', description: '内容资料、分集与发布', to: '/admin/series' },
  { label: '首页配置', description: '分区排序与推荐内容', to: '/admin/operations' },
  { label: '分类与标签', description: '分类、多语言与标签', to: '/admin/taxonomy' },
  { label: '订单管理', description: '支付、退款与权益发放', to: '/admin/orders' },
  { label: '用户与权益', description: '访客、设备与补发权益', to: '/admin/users' },
  { label: '对账中心', description: '收入、手续费与异常', to: '/admin/reconciliation' },
  { label: '站点与支付', description: 'PayPal 与业务规则', to: '/admin/system' },
  { label: '域名管理', description: 'DNS、HTTPS 与跳转', to: '/admin/domains' },
  { label: '审计日志', description: '高风险操作记录', to: '/admin/audit' },
];
const filtered = computed(() => commands.filter((item) => `${item.label} ${item.description}`.toLowerCase().includes(query.value.toLowerCase())));
const openCommand = () => { searchOpen.value = true; nextTick(() => document.querySelector<HTMLInputElement>('.command-search input')?.focus()); };
const go = (to: string) => { searchOpen.value = false; query.value = ''; navigateTo(to); };
const onKeydown = (event: KeyboardEvent) => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); openCommand(); } };
onMounted(() => window.addEventListener('keydown', onKeydown));
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown));
</script>

<template>
  <header class="admin-header">
    <div class="admin-header__start">
      <button class="admin-icon-button desktop-only" type="button" title="折叠侧栏" @click="$emit('toggle-sidebar')"><PanelLeftClose :size="19" /></button>
      <button class="admin-icon-button mobile-only" type="button" aria-label="打开菜单" @click="$emit('open-mobile')"><Menu :size="20" /></button>
      <button class="admin-search" type="button" @click="openCommand"><Search :size="17" /><span>搜索菜单或功能</span><kbd>⌘ K</kbd></button>
    </div>
    <div class="admin-header__end">
      <el-popover placement="bottom-end" :width="300" trigger="click"><template #reference><button class="admin-icon-button has-notice" type="button" title="通知"><Bell :size="19" /></button></template><div class="notification-list"><strong>待处理事项</strong><button type="button" @click="go('/admin/orders')"><span class="health-dot warning" /><div><b>7 笔订单等待确认</b><small>检查 PayPal capture 与回调状态</small></div></button><button type="button" @click="go('/admin/domains')"><span class="health-dot warning" /><div><b>1 个域名等待验证</b><small>完成 CNAME 配置后重新验证</small></div></button></div></el-popover>
      <span class="admin-divider" />
      <el-dropdown @command="(command: string) => command === 'audit' ? go('/admin/audit') : ElMessage.info('当前为演示管理员会话')"><button class="admin-user" type="button"><span class="admin-avatar">AD</span><span class="admin-user__copy"><strong>Admin</strong><small>超级管理员</small></span><ChevronDown :size="15" /></button><template #dropdown><el-dropdown-menu><el-dropdown-item command="audit">我的操作日志</el-dropdown-item><el-dropdown-item command="session" divided>会话信息</el-dropdown-item></el-dropdown-menu></template></el-dropdown>
    </div>
  </header>

  <el-dialog v-model="searchOpen" title="快速导航" width="min(560px, 92vw)" class="command-dialog"><el-input v-model="query" class="command-search" clearable placeholder="输入模块名称或功能"><template #prefix><Search :size="17" /></template></el-input><div class="command-list"><button v-for="item in filtered" :key="item.to" type="button" @click="go(item.to)"><strong>{{ item.label }}</strong><span>{{ item.description }}</span></button><p v-if="!filtered.length">没有匹配的功能</p></div></el-dialog>
</template>
