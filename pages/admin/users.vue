<script setup lang="ts">
import { CloudOff, KeyRound, RefreshCw, Search, ShieldOff, Smartphone, UserCheck } from 'lucide-vue-next';
import { ElMessage, ElMessageBox } from 'element-plus';
import type { PersistedUser, PersistedUserStatus } from '~/types/admin';

definePageMeta({ layout: 'admin' });

const { state, addAudit } = useAdminStore();
const api = useAdminApi();
const keyword = ref('');
const statusFilter = ref<PersistedUserStatus | ''>('');
const country = ref('');
const drawerVisible = ref(false);
const grantVisible = ref(false);
const activeUser = ref<PersistedUser | null>(null);
const grantForm = reactive({ seriesId: '', reason: '' });
const queryParams = computed(() => ({ keyword: keyword.value || undefined, status: statusFilter.value || undefined, country: country.value || undefined, pageSize: 100 }));
const { data, status, error, refresh } = await useAsyncData('admin-users-real', () => api.getUsers(queryParams.value), { watch: [queryParams] });
onMounted(async () => {
  try {
    state.value.series = (await api.getSeries()).items;
  } catch {
    ElMessage.error('可补发权益的短剧列表加载失败');
  }
});
const rows = computed(() => data.value?.items || []);
const statusLabels: Record<PersistedUserStatus, string> = { active: '正常', restricted: '受限', disabled: '已禁用' };
const statusOptions: PersistedUserStatus[] = ['active', 'restricted', 'disabled'];
const statusType = (value: PersistedUserStatus) => ({ active: 'success', restricted: 'warning', disabled: 'danger' }[value]);
const formatDate = (value: string) => new Date(value).toLocaleString('zh-CN', { hour12: false });
const resetFilters = () => { keyword.value = ''; statusFilter.value = ''; country.value = ''; };
const openUser = (user: PersistedUser) => { activeUser.value = user; drawerVisible.value = true; };
const refreshActiveUser = () => {
  if (activeUser.value) activeUser.value = data.value?.items.find((item) => item.id === activeUser.value?.id) || activeUser.value;
};

const changeStatus = async (user: PersistedUser) => {
  const next: PersistedUserStatus = user.status === 'disabled' ? 'active' : 'disabled';
  await ElMessageBox.confirm(`确定将用户状态改为“${statusLabels[next]}”吗？`, next === 'disabled' ? '禁用异常账号' : '恢复账号', { type: 'warning' });
  try {
    const before = user.status;
    await api.updateUserStatus(user.id, next);
    await refresh();
    refreshActiveUser();
    addAudit({ module: '用户与权益', action: next === 'disabled' ? '禁用账号' : '恢复账号', target: user.id, detail: `${statusLabels[before]} → ${statusLabels[next]}`, risk: '高风险' });
    ElMessage.success(`账号已${next === 'disabled' ? '禁用' : '恢复'}`);
  } catch (reason: any) { ElMessage.error(reason?.data?.statusMessage || '用户状态更新失败'); }
};

const releaseDevice = async (user: PersistedUser) => {
  await ElMessageBox.confirm('解除后，该用户可在新设备重新恢复购买。此操作不会删除历史设备记录。', '解除设备限制', { type: 'warning' });
  try {
    await api.releaseUserDevice(user.id);
    await refresh();
    refreshActiveUser();
    addAudit({ module: '用户与权益', action: '解除设备限制', target: user.id, detail: user.device, risk: '高风险' });
    ElMessage.success('设备限制已解除');
  } catch (reason: any) { ElMessage.error(reason?.data?.statusMessage || '设备限制解除失败'); }
};

const openGrant = (user: PersistedUser) => { activeUser.value = user; grantForm.seriesId = ''; grantForm.reason = ''; grantVisible.value = true; };
const grantEntitlement = async () => {
  if (!activeUser.value || !grantForm.seriesId || !grantForm.reason.trim()) return ElMessage.warning('请选择短剧并填写补发原因');
  const series = state.value.series.find((item) => item.id === grantForm.seriesId);
  if (!series) return;
  await ElMessageBox.confirm(`确认向 ${activeUser.value.name} 补发《${series.title}》权益？`, '手工补发权益', { type: 'warning' });
  try {
    await api.grantUserEntitlement(activeUser.value.id, series.id, grantForm.reason.trim());
    await refresh();
    refreshActiveUser();
    addAudit({ module: '用户与权益', action: '手工补发权益', target: activeUser.value.id, detail: `${series.title} · 原因：${grantForm.reason.trim()}`, risk: '高风险' });
    grantVisible.value = false;
    ElMessage.success('权益已写入 Cloudflare D1 并记录审计日志');
  } catch (reason: any) { ElMessage.error(reason?.data?.statusMessage || '权益补发失败'); }
};
</script>

<template>
  <div>
    <AdminPageHeader title="用户与权益" description="用户资料、订单和权益均来自 Cloudflare D1。" />
    <section v-if="status === 'pending'" class="admin-panel admin-data-state"><el-skeleton :rows="8" animated /></section>
    <section v-else-if="error || !data" class="admin-panel admin-data-state"><span><CloudOff :size="28" /></span><h2>无法读取用户资料</h2><p>Cloudflare D1 尚未连接，或用户表迁移尚未执行。</p><el-button @click="() => refresh()"><RefreshCw :size="16" />重试连接</el-button></section>
    <template v-else>
      <div class="live-source-line"><span><i class="health-dot ok" />Cloudflare D1</span><strong>更新于 {{ formatDate(data.generatedAt) }}</strong></div>
      <section class="admin-panel admin-filter-panel"><div class="admin-filter-row"><el-input v-model="keyword" clearable placeholder="姓名、用户 ID、邮箱或设备" class="admin-filter-search"><template #prefix><Search :size="16" /></template></el-input><el-select v-model="statusFilter" placeholder="全部状态" style="width: 130px"><el-option label="全部状态" value="" /><el-option v-for="item in statusOptions" :key="item" :label="statusLabels[item]" :value="item" /></el-select><el-select v-model="country" placeholder="全部地区" style="width: 120px"><el-option label="全部地区" value="" /><el-option v-for="item in data.countries" :key="item" :label="item" :value="item" /></el-select><el-button text @click="resetFilters">重置</el-button><span class="admin-filter-spacer" /><el-button @click="() => refresh()"><RefreshCw :size="15" />刷新</el-button></div></section>
      <section class="admin-panel admin-table-panel"><el-table :data="rows" row-key="id"><el-table-column label="用户 / 关联邮箱" min-width="230"><template #default="scope"><div class="double-line"><strong>{{ scope.row.name }}</strong><span>{{ scope.row.email }}</span></div></template></el-table-column><el-table-column label="地区 / 设备" min-width="190"><template #default="scope"><div class="double-line"><strong>{{ scope.row.country }}</strong><span>{{ scope.row.device }}</span></div></template></el-table-column><el-table-column prop="entitlements" label="已购权益" width="100" /><el-table-column prop="orders" label="订单" width="82" /><el-table-column label="状态" width="100"><template #default="scope"><el-tag :type="statusType(scope.row.status) as any">{{ statusLabels[scope.row.status as PersistedUserStatus] }}</el-tag></template></el-table-column><el-table-column label="最近访问" min-width="165"><template #default="scope">{{ formatDate(scope.row.lastSeenAt) }}</template></el-table-column><el-table-column label="操作" fixed="right" width="160"><template #default="scope"><el-button link type="primary" @click="openUser(scope.row)">详情</el-button><el-button link @click="openGrant(scope.row)">补发权益</el-button></template></el-table-column><template #empty><div class="table-empty"><Search :size="28" /><span>Cloudflare D1 中没有符合条件的用户</span></div></template></el-table><div class="admin-pagination"><span>共 {{ data.total }} 个用户</span></div></section>
    </template>
    <el-drawer v-model="drawerVisible" title="用户与权益详情" size="min(580px, 92vw)"><template v-if="activeUser"><div class="drawer-heading"><div><span>注册用户</span><strong>{{ activeUser.name }}</strong></div><el-tag :type="statusType(activeUser.status) as any">{{ statusLabels[activeUser.status] }}</el-tag></div><el-descriptions :column="1" border class="admin-descriptions"><el-descriptions-item label="用户姓名">{{ activeUser.name }}</el-descriptions-item><el-descriptions-item label="用户 ID">{{ activeUser.id }}</el-descriptions-item><el-descriptions-item label="关联邮箱">{{ activeUser.email }}</el-descriptions-item><el-descriptions-item label="地区">{{ activeUser.country }}</el-descriptions-item><el-descriptions-item label="最近设备">{{ activeUser.device }}</el-descriptions-item><el-descriptions-item label="注册时间">{{ formatDate(activeUser.createdAt) }}</el-descriptions-item><el-descriptions-item label="最近访问">{{ formatDate(activeUser.lastSeenAt) }}</el-descriptions-item><el-descriptions-item label="订单 / 权益">{{ activeUser.orders }} / {{ activeUser.entitlements }}</el-descriptions-item></el-descriptions><section class="drawer-note"><strong>隐私保护</strong><p>邮箱在 D1 中用于订单关联，返回后台页面前会脱敏；完整支付敏感信息不会返回前端。</p></section><div class="drawer-actions"><el-button @click="releaseDevice(activeUser)"><Smartphone :size="15" />解除设备限制</el-button><el-button type="primary" @click="openGrant(activeUser)"><KeyRound :size="15" />补发权益</el-button><el-button :type="activeUser.status === 'disabled' ? 'success' : 'danger'" plain @click="changeStatus(activeUser)"><UserCheck v-if="activeUser.status === 'disabled'" :size="15" /><ShieldOff v-else :size="15" />{{ activeUser.status === 'disabled' ? '恢复账号' : '禁用账号' }}</el-button></div></template></el-drawer>
    <el-dialog v-model="grantVisible" title="手工补发权益" width="min(520px, 92vw)"><el-alert title="补发权益不修改订单支付状态，操作将写入高风险审计日志。" type="warning" :closable="false" show-icon /><el-form label-position="top" class="dialog-form"><el-form-item label="目标用户"><el-input :model-value="activeUser?.name" disabled /></el-form-item><el-form-item label="短剧" required><el-select v-model="grantForm.seriesId" filterable style="width: 100%"><el-option v-for="item in state.series" :key="item.id" :label="item.title" :value="item.id" /></el-select></el-form-item><el-form-item label="补发原因" required><el-input v-model="grantForm.reason" type="textarea" :rows="3" maxlength="200" show-word-limit /></el-form-item></el-form><template #footer><el-button @click="grantVisible = false">取消</el-button><el-button type="primary" @click="grantEntitlement">确认补发</el-button></template></el-dialog>
  </div>
</template>
