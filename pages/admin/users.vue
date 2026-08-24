<script setup lang="ts">
import { CloudOff, KeyRound, RefreshCw, Search, ShieldOff, Smartphone, UserCheck } from 'lucide-vue-next';
import { ElMessage, ElMessageBox } from 'element-plus';
import type { AdminUserDetail, PersistedUser, PersistedUserStatus } from '~/types/admin';

definePageMeta({ layout: 'admin', keepalive: true });

const { state, addAudit } = useAdminStore();
const api = useAdminApi();
const keyword = ref('');
const statusFilter = ref<PersistedUserStatus | ''>('');
const country = ref('');
const drawerVisible = ref(false);
const grantVisible = ref(false);
const activeUser = ref<PersistedUser | null>(null);
const activeDetail = ref<AdminUserDetail | null>(null);
const detailLoading = ref(false);
const detailError = ref('');
const detailTab = ref('history');
const grantForm = reactive({ seriesId: '', reason: '' });
const queryParams = computed(() => ({ keyword: keyword.value || undefined, status: statusFilter.value || undefined, country: country.value || undefined, pageSize: 100 }));
const { data, status, error, refresh } = useLazyAsyncData('admin-users-real', () => api.getUsers(queryParams.value), { watch: [queryParams] });
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
const loadUserDetail = async (userId: string) => {
  detailLoading.value = true;
  detailError.value = '';
  try { activeDetail.value = await api.getUserDetail(userId); }
  catch (reason: any) { detailError.value = reason?.data?.statusMessage || '用户完整资料加载失败'; }
  finally { detailLoading.value = false; }
};
const openUser = (user: PersistedUser) => {
  activeUser.value = user;
  activeDetail.value = null;
  detailTab.value = 'history';
  drawerVisible.value = true;
  void loadUserDetail(user.id);
};
const refreshActiveUser = () => {
  if (activeUser.value) activeUser.value = data.value?.items.find((item) => item.id === activeUser.value?.id) || activeUser.value;
  if (activeUser.value && drawerVisible.value) void loadUserDetail(activeUser.value.id);
};
const formatDuration = (seconds: number) => `${Math.floor(seconds / 60)}分${String(seconds % 60).padStart(2, '0')}秒`;
const formatMoney = (amount: number) => new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'USD' }).format(amount);
const orderStatusLabels: Record<string, string> = { pending: '待支付', processing: '处理中', paid: '已支付', failed: '失败', cancelled: '已取消', refunding: '退款中', refunded: '已退款', risk_review: '风控审核' };
const refundStatusLabels: Record<string, string> = { pending: '待处理', processing: '处理中', completed: '已完成', failed: '失败', rejected: '已拒绝', cancelled: '已取消' };

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
    <el-drawer v-model="drawerVisible" title="完整用户详情" size="min(760px, 96vw)">
      <template v-if="activeUser">
        <div class="drawer-heading"><div><span>注册用户 · {{ activeUser.id }}</span><strong>{{ activeUser.name }}</strong></div><el-tag :type="statusType(activeUser.status) as any">{{ statusLabels[activeUser.status] }}</el-tag></div>
        <div v-if="detailLoading" class="user-detail-state"><el-skeleton :rows="10" animated /></div>
        <el-alert v-else-if="detailError" :title="detailError" type="error" :closable="false" show-icon><template #default><el-button size="small" @click="loadUserDetail(activeUser.id)">重新加载</el-button></template></el-alert>
        <template v-else-if="activeDetail">
          <el-descriptions :column="2" border class="admin-descriptions">
            <el-descriptions-item label="用户姓名">{{ activeDetail.profile.name }}</el-descriptions-item><el-descriptions-item label="关联邮箱">{{ activeDetail.profile.email }}</el-descriptions-item>
            <el-descriptions-item label="地区">{{ activeDetail.profile.country }}</el-descriptions-item><el-descriptions-item label="最近设备">{{ activeDetail.profile.device }}</el-descriptions-item>
            <el-descriptions-item label="注册时间">{{ formatDate(activeDetail.profile.createdAt) }}</el-descriptions-item><el-descriptions-item label="最近访问">{{ formatDate(activeDetail.profile.lastSeenAt) }}</el-descriptions-item>
            <el-descriptions-item label="账号语言">{{ activeDetail.profile.language.toUpperCase() }}</el-descriptions-item><el-descriptions-item label="订单 / 有效权益">{{ activeDetail.profile.orders }} / {{ activeDetail.profile.entitlements }}</el-descriptions-item>
            <el-descriptions-item label="隐私偏好" :span="2">推荐 {{ activeDetail.profile.privacy.recommendations ? '开' : '关' }} · 分析 {{ activeDetail.profile.privacy.analytics ? '开' : '关' }} · 营销 {{ activeDetail.profile.privacy.marketing ? '开' : '关' }}</el-descriptions-item>
          </el-descriptions>
          <el-tabs v-model="detailTab" class="user-detail-tabs">
            <el-tab-pane :label="`观看记录 ${activeDetail.watchHistory.length}`" name="history">
              <el-table :data="activeDetail.watchHistory" max-height="360" size="small"><el-table-column label="短剧" min-width="170"><template #default="scope"><div class="double-line"><strong>{{ scope.row.seriesTitle }}</strong><span>{{ scope.row.seriesId }}</span></div></template></el-table-column><el-table-column label="进度" min-width="135"><template #default="scope">第 {{ scope.row.episodeNo }} 集 · {{ formatDuration(scope.row.positionSeconds) }} / {{ formatDuration(scope.row.durationSeconds) }}</template></el-table-column><el-table-column label="状态" width="75"><template #default="scope"><el-tag :type="scope.row.completed ? 'success' : 'info'">{{ scope.row.completed ? '已看完' : '观看中' }}</el-tag></template></el-table-column><el-table-column label="最近观看" min-width="155"><template #default="scope">{{ formatDate(scope.row.lastWatchedAt) }}</template></el-table-column><template #empty><div class="user-detail-empty">暂无观看记录</div></template></el-table>
            </el-tab-pane>
            <el-tab-pane :label="`订单与退款 ${activeDetail.orders.length}`" name="orders">
              <div class="user-order-details"><article v-for="order in activeDetail.orders" :key="order.orderNo"><header><div><strong>{{ order.seriesTitle }}</strong><span>{{ order.orderNo }} · {{ formatDate(order.createdAt) }}</span></div><div><strong>{{ formatMoney(order.amount) }}</strong><el-tag>{{ orderStatusLabels[order.status] || order.status }}</el-tag></div></header><dl><div><dt>PayPal 订单</dt><dd>{{ order.paypalOrderId || '—' }}</dd></div><div><dt>捕获 ID</dt><dd>{{ order.captureId || '—' }}</dd></div><div><dt>手续费 / 净额</dt><dd>{{ formatMoney(order.fee) }} / {{ formatMoney(order.netAmount) }}</dd></div><div><dt>权益状态</dt><dd>{{ order.entitlement }}</dd></div></dl><section v-if="order.refund.status" class="user-refund-detail"><strong>退款：{{ refundStatusLabels[order.refund.status] || order.refund.status }}</strong><span>渠道 {{ order.refund.source || '—' }} · PayPal 退款 ID {{ order.refund.paypalRefundId || '—' }}</span><span>权益回收 {{ order.refund.entitlementRevokeStatus || '—' }} · {{ order.refund.updatedAt ? formatDate(order.refund.updatedAt) : '—' }}</span><p v-if="order.refund.errorMessage">{{ order.refund.errorMessage }}</p></section></article><div v-if="!activeDetail.orders.length" class="user-detail-empty">暂无订单或退款记录</div></div>
            </el-tab-pane>
            <el-tab-pane :label="`权益 ${activeDetail.entitlements.length}`" name="entitlements">
              <el-table :data="activeDetail.entitlements" max-height="360" size="small"><el-table-column label="短剧" min-width="180"><template #default="scope"><div class="double-line"><strong>{{ scope.row.seriesTitle }}</strong><span>{{ scope.row.seriesId }}</span></div></template></el-table-column><el-table-column label="来源" width="80"><template #default="scope">{{ scope.row.source === 'manual' ? '手工补发' : '订单' }}</template></el-table-column><el-table-column label="状态" width="82"><template #default="scope"><el-tag :type="scope.row.status === 'granted' ? 'success' : 'info'">{{ scope.row.status === 'granted' ? '有效' : '已撤销' }}</el-tag></template></el-table-column><el-table-column label="发放时间" min-width="155"><template #default="scope">{{ formatDate(scope.row.grantedAt) }}</template></el-table-column><template #empty><div class="user-detail-empty">暂无权益记录</div></template></el-table>
            </el-tab-pane>
          </el-tabs>
          <section class="drawer-note"><strong>隐私保护</strong><p>邮箱已脱敏；支付凭证仅显示用于客服核验的提供商引用，不返回支付账户敏感信息。</p></section>
        </template>
        <div class="drawer-actions"><el-button @click="releaseDevice(activeUser)"><Smartphone :size="15" />解除设备限制</el-button><el-button type="primary" @click="openGrant(activeUser)"><KeyRound :size="15" />补发权益</el-button><el-button :type="activeUser.status === 'disabled' ? 'success' : 'danger'" plain @click="changeStatus(activeUser)"><UserCheck v-if="activeUser.status === 'disabled'" :size="15" /><ShieldOff v-else :size="15" />{{ activeUser.status === 'disabled' ? '恢复账号' : '禁用账号' }}</el-button></div>
      </template>
    </el-drawer>
    <el-dialog v-model="grantVisible" title="手工补发权益" width="min(520px, 92vw)"><el-alert title="补发权益不修改订单支付状态，操作将写入高风险审计日志。" type="warning" :closable="false" show-icon /><el-form label-position="top" class="dialog-form"><el-form-item label="目标用户"><el-input :model-value="activeUser?.name" disabled /></el-form-item><el-form-item label="短剧" required><el-select v-model="grantForm.seriesId" filterable style="width: 100%"><el-option v-for="item in state.series" :key="item.id" :label="item.title" :value="item.id" /></el-select></el-form-item><el-form-item label="补发原因" required><el-input v-model="grantForm.reason" type="textarea" :rows="3" maxlength="200" show-word-limit /></el-form-item></el-form><template #footer><el-button @click="grantVisible = false">取消</el-button><el-button type="primary" @click="grantEntitlement">确认补发</el-button></template></el-dialog>
  </div>
</template>
