<script setup lang="ts">
import { AlertTriangle, CloudOff, Download, ReceiptText, RefreshCw } from 'lucide-vue-next';
import { ElMessage } from 'element-plus';

definePageMeta({ layout: 'admin', keepalive: true });
const api = useAdminApi();
const period = ref<'今日' | '近 7 天' | '近 30 天'>('近 7 天');
const days = computed(() => ({ 今日: 1, '近 7 天': 7, '近 30 天': 30 }[period.value]));
const { data, status, error, refresh } = useLazyAsyncData('admin-reconciliation-real', () => api.getReconciliation(days.value), { watch: [days] });
const rows = computed(() => data.value?.rows || []);
const totals = computed(() => rows.value.reduce((sum, row) => ({ gross: sum.gross + row.gross, fee: sum.fee + row.fee, refunds: sum.refunds + row.refunds, net: sum.net + row.net, paid: sum.paid + row.paid, exceptions: sum.exceptions + row.exceptions }), { gross: 0, fee: 0, refunds: 0, net: 0, paid: 0, exceptions: 0 }));
const maxGross = computed(() => Math.max(1, ...rows.value.map((row) => row.gross)));
const exportReport = () => {
  downloadCsv(`reelnova-reconciliation-${days.value}d-real.csv`, ['日期', '币种', '成功金额', '手续费', '退款金额', '净额', '成功支付数', '异常订单'], rows.value.map((row) => [row.date, row.currency, row.gross.toFixed(2), row.fee.toFixed(2), row.refunds.toFixed(2), row.net.toFixed(2), row.paid, row.exceptions]));
  ElMessage.success('真实对账报表已导出');
};
</script>

<template>
  <div>
    <AdminPageHeader title="对账中心" description="数据直接聚合自 Cloudflare D1 中经 PayPal 验证的订单。"><el-button :disabled="!data" @click="exportReport"><Download :size="16" />导出对账 CSV</el-button></AdminPageHeader>
    <section v-if="status === 'pending'" class="admin-panel admin-data-state"><el-skeleton :rows="8" animated /></section>
    <section v-else-if="error || !data" class="admin-panel admin-data-state"><span><CloudOff :size="28" /></span><h2>无法读取对账数据</h2><p>Cloudflare D1 尚未连接或订单数据表未初始化。</p><el-button @click="() => refresh()"><RefreshCw :size="16" />重试连接</el-button></section>
    <template v-else>
      <section class="admin-panel admin-filter-panel"><div class="admin-filter-row"><el-segmented v-model="period" :options="['今日', '近 7 天', '近 30 天']" /><el-select model-value="USD" disabled style="width: 110px"><el-option label="USD" value="USD" /></el-select><span class="admin-filter-spacer" /><span class="filter-summary">Cloudflare D1 · 更新于 {{ new Date(data.generatedAt).toLocaleString('zh-CN', { hour12: false }) }}</span></div></section>
      <section class="order-summary-row"><article><span>成功金额</span><strong>${{ totals.gross.toFixed(2) }}</strong></article><article><span>PayPal 手续费</span><strong>${{ totals.fee.toFixed(2) }}</strong></article><article><span>退款金额</span><strong class="warning-text">${{ totals.refunds.toFixed(2) }}</strong></article><article><span>预计净额</span><strong>${{ totals.net.toFixed(2) }}</strong></article></section>
      <div class="reconciliation-grid"><section class="admin-panel reconciliation-chart"><div class="admin-panel__header"><div><h2>每日成功金额</h2><p>只统计 status = paid 的已验证订单</p></div><el-tag type="success">{{ totals.paid.toLocaleString() }} 笔成功支付</el-tag></div><div v-if="rows.length" class="revenue-bars"><div v-for="row in rows" :key="`${row.date}-${row.currency}`" class="revenue-bar"><strong>${{ row.gross.toFixed(0) }}</strong><span :style="{ height: `${Math.max(2, Math.round(row.gross / maxGross * 100))}%` }" /><small>{{ row.date.slice(5) }}</small></div></div><div v-else class="table-empty"><ReceiptText :size="28" /><span>该时段暂无已确认支付</span></div></section><aside class="admin-panel exception-panel"><div class="admin-panel__header"><div><h2>对账异常</h2><p>failed + risk_review</p></div><AlertTriangle :size="20" /></div><div class="exception-count"><strong>{{ totals.exceptions }}</strong><span>{{ period }}异常订单</span></div><p class="exception-note">金额或币种不一致的订单会进入风控审核，不计入收入且不发放权益。</p><el-button type="primary" plain @click="navigateTo('/admin/orders')">查看订单核验</el-button></aside></div>
      <section class="admin-panel admin-table-panel"><div class="admin-panel__header"><div><h2>每日结算明细</h2><p>净额 = 成功金额 - 手续费 - 退款</p></div><ReceiptText :size="18" /></div><el-table :data="rows"><el-table-column prop="date" label="日期" min-width="130" /><el-table-column label="成功金额" min-width="120"><template #default="scope">${{ scope.row.gross.toFixed(2) }}</template></el-table-column><el-table-column label="手续费" min-width="110"><template #default="scope">${{ scope.row.fee.toFixed(2) }}</template></el-table-column><el-table-column label="退款" min-width="100"><template #default="scope">${{ scope.row.refunds.toFixed(2) }}</template></el-table-column><el-table-column label="预计净额" min-width="120"><template #default="scope"><strong>${{ scope.row.net.toFixed(2) }}</strong></template></el-table-column><el-table-column prop="paid" label="成功支付" width="100" /><el-table-column label="异常" width="90"><template #default="scope"><el-tag :type="scope.row.exceptions ? 'danger' : 'success'">{{ scope.row.exceptions }}</el-tag></template></el-table-column></el-table></section>
    </template>
  </div>
</template>
