<script setup lang="ts">
import { KeyRound, Search, ShieldOff, Smartphone, UserCheck } from 'lucide-vue-next';
import { ElMessage, ElMessageBox } from 'element-plus';
import type { AdminUser } from '~/composables/useAdminStore';

definePageMeta({ layout: 'admin' });

const { state, addAudit } = useAdminStore();
const keyword = ref('');
const status = ref('全部状态');
const country = ref('全部地区');
const drawerVisible = ref(false);
const grantVisible = ref(false);
const activeUser = ref<AdminUser | null>(null);
const grantForm = reactive({ seriesId: '', reason: '' });
const rows = computed(() => state.value.users.filter((user) => {
  const text = keyword.value.toLowerCase().trim();
  return (!text || `${user.id} ${user.email} ${user.device}`.toLowerCase().includes(text)) && (status.value === '全部状态' || user.status === status.value) && (country.value === '全部地区' || user.country === country.value);
}));
const statusType = (value: string) => ({ 正常: 'success', 受限: 'warning', 已禁用: 'danger' }[value] || 'info');
const openUser = (user: AdminUser) => { activeUser.value = user; drawerVisible.value = true; };

const changeStatus = async (user: AdminUser) => {
  const next = user.status === '已禁用' ? '正常' : '已禁用';
  await ElMessageBox.confirm(`确定将用户状态改为“${next}”吗？`, next === '已禁用' ? '禁用异常账号' : '恢复账号', { type: 'warning' });
  const before = user.status;
  user.status = next;
  addAudit({ module: '用户与权益', action: next === '已禁用' ? '禁用账号' : '恢复账号', target: user.id, detail: `${before} → ${next}`, risk: '高风险' });
  ElMessage.success(`账号已${next === '已禁用' ? '禁用' : '恢复'}`);
};

const releaseDevice = async (user: AdminUser) => {
  await ElMessageBox.confirm('解除后，该访客可在新设备重新恢复购买。此操作不会删除历史设备记录。', '解除设备限制', { type: 'warning' });
  if (user.status === '受限') user.status = '正常';
  addAudit({ module: '用户与权益', action: '解除设备限制', target: user.id, detail: user.device, risk: '高风险' });
  ElMessage.success('设备限制已解除');
};

const openGrant = (user: AdminUser) => { activeUser.value = user; grantForm.seriesId = ''; grantForm.reason = ''; grantVisible.value = true; };
const grantEntitlement = async () => {
  if (!activeUser.value || !grantForm.seriesId || !grantForm.reason.trim()) return ElMessage.warning('请选择短剧并填写补发原因');
  const series = state.value.series.find((item) => item.id === grantForm.seriesId);
  if (!series) return;
  await ElMessageBox.confirm(`确认向 ${activeUser.value.id} 补发《${series.title}》权益？`, '手工补发权益', { type: 'warning' });
  activeUser.value.entitlements += 1;
  addAudit({ module: '用户与权益', action: '手工补发权益', target: activeUser.value.id, detail: `${series.title} · 原因：${grantForm.reason.trim()}`, risk: '高风险' });
  grantVisible.value = false;
  ElMessage.success('权益已补发并记录审计日志');
};
</script>

<template>
  <div>
    <AdminPageHeader title="用户与权益" description="查询匿名访客、购买权益、观看设备和账号限制。" />
    <section class="admin-panel admin-filter-panel"><div class="admin-filter-row"><el-input v-model="keyword" clearable placeholder="访客 ID、邮箱或设备" class="admin-filter-search"><template #prefix><Search :size="16" /></template></el-input><el-select v-model="status" style="width: 130px"><el-option v-for="item in ['全部状态', '正常', '受限', '已禁用']" :key="item" :label="item" :value="item" /></el-select><el-select v-model="country" style="width: 120px"><el-option v-for="item in ['全部地区', 'US', 'CA', 'GB']" :key="item" :label="item" :value="item" /></el-select><el-button text @click="keyword = ''; status = '全部状态'; country = '全部地区'">重置</el-button></div></section>
    <section class="admin-panel admin-table-panel"><el-table :data="rows" row-key="id"><el-table-column label="访客 / 关联邮箱" min-width="230"><template #default="scope"><div class="double-line"><strong>{{ scope.row.id }}</strong><span>{{ scope.row.email }}</span></div></template></el-table-column><el-table-column label="地区 / 设备" min-width="190"><template #default="scope"><div class="double-line"><strong>{{ scope.row.country }}</strong><span>{{ scope.row.device }}</span></div></template></el-table-column><el-table-column prop="entitlements" label="已购权益" width="100" /><el-table-column prop="orders" label="订单" width="82" /><el-table-column label="状态" width="100"><template #default="scope"><el-tag :type="statusType(scope.row.status) as any">{{ scope.row.status }}</el-tag></template></el-table-column><el-table-column prop="lastSeenAt" label="最近访问" min-width="155" /><el-table-column label="操作" fixed="right" width="160"><template #default="scope"><el-button link type="primary" @click="openUser(scope.row)">详情</el-button><el-button link @click="openGrant(scope.row)">补发权益</el-button></template></el-table-column></el-table><div class="admin-pagination"><span>共 {{ rows.length }} 个访客</span></div></section>
    <el-drawer v-model="drawerVisible" title="用户与权益详情" size="min(580px, 92vw)"><template v-if="activeUser"><div class="drawer-heading"><div><span>匿名访客 ID</span><strong>{{ activeUser.id }}</strong></div><el-tag :type="statusType(activeUser.status) as any">{{ activeUser.status }}</el-tag></div><el-descriptions :column="1" border class="admin-descriptions"><el-descriptions-item label="关联邮箱">{{ activeUser.email }}</el-descriptions-item><el-descriptions-item label="地区">{{ activeUser.country }}</el-descriptions-item><el-descriptions-item label="最近设备">{{ activeUser.device }}</el-descriptions-item><el-descriptions-item label="注册时间">{{ activeUser.createdAt }}</el-descriptions-item><el-descriptions-item label="最近访问">{{ activeUser.lastSeenAt }}</el-descriptions-item><el-descriptions-item label="订单 / 权益">{{ activeUser.orders }} / {{ activeUser.entitlements }}</el-descriptions-item></el-descriptions><section class="drawer-note"><strong>隐私保护</strong><p>邮箱与支付标识均已脱敏；完整支付敏感信息不会返回后台前端。</p></section><div class="drawer-actions"><el-button @click="releaseDevice(activeUser)"><Smartphone :size="15" />解除设备限制</el-button><el-button type="primary" @click="openGrant(activeUser)"><KeyRound :size="15" />补发权益</el-button><el-button :type="activeUser.status === '已禁用' ? 'success' : 'danger'" plain @click="changeStatus(activeUser)"><UserCheck v-if="activeUser.status === '已禁用'" :size="15" /><ShieldOff v-else :size="15" />{{ activeUser.status === '已禁用' ? '恢复账号' : '禁用账号' }}</el-button></div></template></el-drawer>
    <el-dialog v-model="grantVisible" title="手工补发权益" width="min(520px, 92vw)"><el-alert title="补发权益不修改订单支付状态，操作将写入高风险审计日志。" type="warning" :closable="false" show-icon /><el-form label-position="top" class="dialog-form"><el-form-item label="目标访客"><el-input :model-value="activeUser?.id" disabled /></el-form-item><el-form-item label="短剧" required><el-select v-model="grantForm.seriesId" filterable style="width: 100%"><el-option v-for="item in state.series" :key="item.id" :label="item.title" :value="item.id" /></el-select></el-form-item><el-form-item label="补发原因" required><el-input v-model="grantForm.reason" type="textarea" :rows="3" maxlength="200" show-word-limit /></el-form-item></el-form><template #footer><el-button @click="grantVisible = false">取消</el-button><el-button type="primary" @click="grantEntitlement">确认补发</el-button></template></el-dialog>
  </div>
</template>
