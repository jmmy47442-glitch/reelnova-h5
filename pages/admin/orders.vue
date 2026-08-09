<script setup lang="ts">
import { CloudOff, Download, RefreshCw, Search } from 'lucide-vue-next';
import { ElMessage } from 'element-plus';
import type { PersistedOrder, PersistedOrderStatus } from '~/types/admin';

definePageMeta({ layout: 'admin' });
const api = useAdminApi();
const statusFilter = ref('');
const country = ref('');
const keyword = ref('');
const dateRange = ref<[Date, Date] | undefined>();
const detailVisible = ref(false);
const activeOrder = ref<PersistedOrder | null>(null);
const verifying = ref('');
const statusOptions: Array<{ label: string; value: PersistedOrderStatus | '' }> = [
  { label: '全部状态', value: '' }, { label: '已支付', value: 'paid' }, { label: '处理中', value: 'processing' }, { label: '待支付', value: 'pending' },
  { label: '支付失败', value: 'failed' }, { label: '退款中', value: 'refunding' }, { label: '已退款', value: 'refunded' }, { label: '风控审核', value: 'risk_review' },
];
const labels: Record<PersistedOrderStatus, string> = { pending: '待支付', processing: '处理中', paid: '已支付', failed: '支付失败', cancelled: '已取消', refunding: '退款中', refunded: '已退款', risk_review: '风控审核' };
const entitlementLabels = { pending: '待发放', granted: '已发放', revoked: '已回收' };
const queryParams = computed(() => ({
  keyword: keyword.value || undefined, status: statusFilter.value || undefined, country: country.value || undefined,
  from: dateRange.value?.[0]?.toISOString(), to: dateRange.value?.[1] ? new Date(dateRange.value[1].getTime() + 86_399_999).toISOString() : undefined, pageSize: 100,
}));
const { data, status, error, refresh } = await useAsyncData('admin-orders-real', () => api.getOrders(queryParams.value), { watch: [queryParams] });
const rows = computed(() => data.value?.items || []);
const type = (value: PersistedOrderStatus) => ({ paid: 'success', processing: 'warning', pending: 'info', failed: 'danger', cancelled: 'info', refunding: 'primary', refunded: 'info', risk_review: 'danger' }[value]);
const resetFilters = () => { statusFilter.value = ''; country.value = ''; keyword.value = ''; dateRange.value = undefined; };
const openDetail = (order: PersistedOrder) => { activeOrder.value = order; detailVisible.value = true; };

const verify = async (order: PersistedOrder) => {
  verifying.value = order.orderNo;
  try {
    const result = await api.verifyOrder(order.orderNo);
    await refresh();
    if (activeOrder.value?.orderNo === order.orderNo) activeOrder.value = data.value?.items.find((item) => item.orderNo === order.orderNo) || activeOrder.value;
    ElMessage[result.synchronized ? 'success' : 'info'](result.synchronized ? 'PayPal capture 已验证，订单与权益已同步' : `PayPal 状态：${result.paypalStatus}`);
  } catch (reason: any) { ElMessage.error(reason?.data?.statusMessage || 'PayPal 核验失败'); }
  finally { verifying.value = ''; }
};
const exportOrders = () => {
  downloadCsv('reelnova-orders-real.csv', ['本地订单号', '剧名', '用户', '国家', '金额', '币种', '手续费', '净额', '状态', 'PayPal Order ID', 'Capture ID', '创建时间', '回调时间'], rows.value.map((order) => [order.orderNo, order.seriesTitle, order.email || '', order.country || '', order.amount.toFixed(2), order.currency, order.fee.toFixed(2), order.netAmount.toFixed(2), labels[order.status], order.paypalOrderId || '', order.captureId || '', order.createdAt, order.callbackAt || '']));
  ElMessage.success(`已导出 ${rows.value.length} 笔真实订单`);
};
</script>

<template>
  <div>
    <AdminPageHeader title="订单管理" description="订单来自 Cloudflare D1，支付状态以 PayPal 已验证 capture 和 Webhook 为准。"><el-button :disabled="!data" @click="exportOrders"><Download :size="16" />导出 CSV</el-button></AdminPageHeader>
    <section v-if="status === 'pending'" class="admin-panel admin-data-state"><el-skeleton :rows="8" animated /></section>
    <section v-else-if="error || !data" class="admin-panel admin-data-state"><span><CloudOff :size="28" /></span><h2>无法读取真实订单</h2><p>Cloudflare D1 尚未连接或数据表未初始化。</p><el-button @click="() => refresh()"><RefreshCw :size="16" />重试连接</el-button></section>
    <template v-else>
      <div class="live-source-line"><span><i class="health-dot ok" />Cloudflare D1</span><strong>更新于 {{ new Date(data.generatedAt).toLocaleString('zh-CN', { hour12: false }) }}</strong></div>
      <section class="order-summary-row"><article><span>今日订单</span><strong>{{ data.summary.todayOrders }}</strong></article><article><span>今日成功金额</span><strong>${{ data.summary.paidAmount.toFixed(2) }}</strong></article><article><span>待确认</span><strong class="warning-text">{{ data.summary.pending }}</strong></article><article><span>异常订单</span><strong class="danger-text">{{ data.summary.exceptions }}</strong></article></section>
      <section class="admin-panel admin-filter-panel"><div class="admin-filter-row"><el-input v-model="keyword" clearable placeholder="订单号、邮箱、剧名、PayPal ID" class="admin-filter-search"><template #prefix><Search :size="16" /></template></el-input><el-select v-model="statusFilter" style="width: 140px"><el-option v-for="item in statusOptions" :key="item.value" :label="item.label" :value="item.value" /></el-select><el-select v-model="country" style="width: 120px"><el-option label="全部地区" value="" /><el-option v-for="item in ['US', 'CA', 'GB', 'AU']" :key="item" :label="item" :value="item" /></el-select><el-date-picker v-model="dateRange" type="daterange" range-separator="至" start-placeholder="开始日期" end-placeholder="结束日期" /><el-button text @click="resetFilters">重置</el-button><span class="admin-filter-spacer" /><el-button @click="() => refresh()"><RefreshCw :size="15" />刷新</el-button></div></section>
      <section class="admin-panel admin-table-panel"><el-table :data="rows" row-key="orderNo"><el-table-column prop="orderNo" label="本地订单号" min-width="176" /><el-table-column label="短剧 / 用户" min-width="220"><template #default="scope"><div class="double-line"><strong>{{ scope.row.seriesTitle }}</strong><span>{{ scope.row.email || '未提供邮箱' }} · {{ scope.row.country || '未知地区' }}</span></div></template></el-table-column><el-table-column label="金额" width="92"><template #default="scope"><strong>${{ scope.row.amount.toFixed(2) }}</strong></template></el-table-column><el-table-column label="状态" width="106"><template #default="scope"><el-tag :type="type(scope.row.status) as any">{{ labels[scope.row.status as PersistedOrderStatus] }}</el-tag></template></el-table-column><el-table-column label="权益" width="92"><template #default="scope"><span :class="{ 'success-text': scope.row.entitlement === 'granted' }">{{ entitlementLabels[scope.row.entitlement as keyof typeof entitlementLabels] }}</span></template></el-table-column><el-table-column prop="paypalOrderId" label="PayPal Order ID" min-width="145" /><el-table-column label="创建时间" min-width="154"><template #default="scope">{{ new Date(scope.row.createdAt).toLocaleString('zh-CN', { hour12: false }) }}</template></el-table-column><el-table-column label="操作" fixed="right" width="150"><template #default="scope"><el-button link type="primary" @click="openDetail(scope.row)">详情</el-button><el-button link :loading="verifying === scope.row.orderNo" @click="verify(scope.row)">核验</el-button></template></el-table-column><template #empty><div class="table-empty"><Search :size="28" /><span>Cloudflare D1 中没有符合条件的订单</span></div></template></el-table><div class="admin-pagination"><span>共 {{ data.total }} 条</span></div></section>
    </template>

    <el-drawer v-model="detailVisible" title="订单详情" size="min(560px, 92vw)"><template v-if="activeOrder"><div class="drawer-heading"><div><span>本地订单号</span><strong>{{ activeOrder.orderNo }}</strong></div><el-tag :type="type(activeOrder.status) as any">{{ labels[activeOrder.status] }}</el-tag></div><el-descriptions :column="1" border class="admin-descriptions"><el-descriptions-item label="短剧">{{ activeOrder.seriesTitle }}</el-descriptions-item><el-descriptions-item label="用户">{{ activeOrder.email || '未提供' }} · {{ activeOrder.country || '未知' }}</el-descriptions-item><el-descriptions-item label="订单金额">${{ activeOrder.amount.toFixed(2) }} {{ activeOrder.currency }}</el-descriptions-item><el-descriptions-item label="手续费 / 净额">${{ activeOrder.fee.toFixed(2) }} / ${{ activeOrder.netAmount.toFixed(2) }}</el-descriptions-item><el-descriptions-item label="PayPal Order ID">{{ activeOrder.paypalOrderId || '—' }}</el-descriptions-item><el-descriptions-item label="Capture ID">{{ activeOrder.captureId || '—' }}</el-descriptions-item><el-descriptions-item label="回调时间">{{ activeOrder.callbackAt ? new Date(activeOrder.callbackAt).toLocaleString('zh-CN', { hour12: false }) : '—' }}</el-descriptions-item><el-descriptions-item label="权益状态">{{ entitlementLabels[activeOrder.entitlement] }}</el-descriptions-item></el-descriptions><section class="drawer-note"><strong>服务端记录</strong><p>{{ activeOrder.note || '暂无异常记录。订单状态由 PayPal 核验结果自动维护。' }}</p></section><div class="drawer-actions"><el-button :loading="verifying === activeOrder.orderNo" @click="verify(activeOrder)"><RefreshCw :size="15" />从 PayPal 重新核验</el-button></div></template></el-drawer>
  </div>
</template>
