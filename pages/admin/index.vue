<script setup lang="ts">
import { ArrowDownRight, ArrowUpRight, CircleDollarSign, CloudOff, Download, Eye, Film, Plus, RefreshCw, ShoppingCart, TriangleAlert } from 'lucide-vue-next';
import { ElMessage } from 'element-plus';
import { usePageData } from '~/composables/usePageData';

definePageMeta({ layout: 'admin', keepalive: true });
const api = useAdminApi();
const { can } = useAdminAuth();
const { formatViews } = useFormatters();
const chartMode = ref<'播放量' | '收入'>('播放量');
const selectedTrendDate = ref<string | null>(null);
const { data, status, error, refresh } = usePageData('admin-dashboard-real', () => api.getDashboard());

const formatChange = (value: number | null) => value === null ? '新数据' : `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`;
const metrics = computed(() => data.value ? [
  { label: '今日播放量', value: data.value.metrics.plays.value.toLocaleString(), metric: data.value.metrics.plays, icon: Eye, color: 'blue' },
  { label: '今日订单', value: data.value.metrics.orders.value.toLocaleString(), metric: data.value.metrics.orders, icon: ShoppingCart, color: 'green' },
  { label: '已确认收入', value: `$${data.value.metrics.revenue.value.toFixed(2)}`, metric: data.value.metrics.revenue, icon: CircleDollarSign, color: 'orange' },
  { label: '异常订单', value: data.value.metrics.exceptions.value.toLocaleString(), metric: data.value.metrics.exceptions, icon: TriangleAlert, color: 'purple' },
] : []);
const chartValues = computed(() => data.value?.trends.map((point) => chartMode.value === '播放量' ? point.plays : point.revenue) || []);
const chartMax = computed(() => Math.max(1, ...chartValues.value));
const selectedTrend = computed(() => {
  const trends = data.value?.trends || [];
  return trends.find((point) => point.date === selectedTrendDate.value) || trends.at(-1) || null;
});
const formatTrendDate = (date: string) => new Date(`${date}T00:00:00Z`).toLocaleDateString('zh-CN', {
  month: 'long',
  day: 'numeric',
  timeZone: 'UTC',
});
const errorMessage = computed(() => {
  const detail = error.value as { data?: { data?: { message?: string } }; statusMessage?: string } | null | undefined;
  return detail?.data?.data?.message || detail?.statusMessage || 'Cloudflare D1 连接失败';
});

const downloadReport = () => {
  if (!data.value) return;
  downloadCsv('reelnova-dashboard-real.csv', ['日期', '播放量', '已确认收入(USD)'], data.value.trends.map((point) => [point.date, point.plays, point.revenue.toFixed(2)]));
  ElMessage.success('真实数据报表已导出');
};
</script>

<template>
  <div>
    <AdminPageHeader title="数据概览" description="数据来自 Cloudflare D1；播放事件与 PayPal 已确认订单实时聚合。"><el-button :loading="status === 'pending'" @click="() => refresh()"><RefreshCw :size="16" />刷新</el-button><el-button :disabled="!data" @click="downloadReport"><Download :size="16" />下载报表</el-button><el-button v-if="can('content.manage')" type="primary" @click="navigateTo('/admin/series')"><Plus :size="16" />创建短剧</el-button></AdminPageHeader>

    <section v-if="status === 'pending'" class="admin-panel admin-data-state"><el-skeleton :rows="8" animated /></section>
    <section v-else-if="error || !data" class="admin-panel admin-data-state"><span><CloudOff :size="28" /></span><h2>Cloudflare 尚未连接</h2><p>{{ errorMessage }}</p><div><el-button @click="() => refresh()"><RefreshCw :size="16" />重试连接</el-button><NuxtLink v-if="can('system.read')" to="/admin/system" class="el-button el-button--primary">检查配置</NuxtLink></div></section>

    <template v-else>
      <div class="live-source-line"><span><i class="health-dot ok" />{{ data.source }}</span><strong>更新于 {{ new Date(data.generatedAt).toLocaleString('zh-CN', { hour12: false }) }} · {{ data.timezone }}</strong></div>
      <section class="admin-metric-grid"><article v-for="item in metrics" :key="item.label" class="admin-panel admin-metric"><div class="admin-metric__top"><span class="admin-metric__icon" :class="`is-${item.color}`"><component :is="item.icon" :size="21" /></span><span class="admin-metric__change" :class="item.metric.changePercent !== null && item.metric.changePercent < 0 ? 'down' : 'up'"><ArrowDownRight v-if="item.metric.changePercent !== null && item.metric.changePercent < 0" :size="14" /><ArrowUpRight v-else :size="14" />{{ formatChange(item.metric.changePercent) }}</span></div><span>{{ item.label }}</span><strong>{{ item.value }}</strong><small>昨日同期 {{ item.metric.previousValue.toLocaleString() }}</small></article></section>
      <section class="admin-dashboard-grid"><article class="admin-panel admin-chart-panel"><div class="admin-panel__header"><div><h2>播放与收入趋势</h2><p>最近 14 天真实记录</p></div><el-segmented v-model="chartMode" :options="['播放量', '收入']" size="small" /></div><div v-if="selectedTrend" class="bar-chart__selection" aria-live="polite"><strong>{{ formatTrendDate(selectedTrend.date) }}</strong><dl><div><dt>播放量</dt><dd>{{ selectedTrend.plays.toLocaleString() }}</dd></div><div><dt>收入</dt><dd>${{ selectedTrend.revenue.toFixed(2) }}</dd></div></dl></div><div class="bar-chart" role="group" aria-label="最近十四天播放与收入趋势"><button v-for="(point, index) in data.trends" :key="point.date" type="button" class="bar-chart__column" :class="{ 'is-selected': selectedTrend?.date === point.date }" :aria-label="`${formatTrendDate(point.date)}，播放量 ${point.plays.toLocaleString()}，收入 $${point.revenue.toFixed(2)}`" :aria-pressed="selectedTrend?.date === point.date" @click="selectedTrendDate = point.date"><span class="bar-chart__bar" :style="{ height: `${Math.max(2, chartValues[index] / chartMax * 100)}%` }" aria-hidden="true" /><small>{{ selectedTrend?.date === point.date || index % 2 === 0 ? point.date.slice(5) : '' }}</small></button></div></article><article class="admin-panel admin-health-panel"><div class="admin-panel__header"><div><h2>数据链路</h2><p>Cloudflare 与 PayPal 状态</p></div><span class="admin-status-ok">D1 已连接</span></div><ul><li><span><i class="health-dot ok" />Cloudflare D1</span><strong>正常</strong></li><li><span><i class="health-dot" :class="data.health.lastWebhookAt ? 'ok' : 'warning'" />最近 PayPal Webhook</span><strong>{{ data.health.lastWebhookAt ? new Date(data.health.lastWebhookAt).toLocaleString('zh-CN', { hour12: false }) : '暂无' }}</strong></li><li><span><i class="health-dot warning" />待确认订单</span><strong>{{ data.health.pendingOrders }} 笔</strong></li><li><span><i class="health-dot" :class="data.health.failedWebhooks ? 'warning' : 'ok'" />Webhook 处理失败</span><strong>{{ data.health.failedWebhooks }} 条</strong></li></ul></article></section>
      <section class="admin-panel admin-table-panel"><div class="admin-panel__header"><div><h2>热门短剧</h2><p>近 7 天，按已确认收入排序</p></div><NuxtLink to="/admin/orders">查看订单</NuxtLink></div><el-table :data="data.topSeries"><el-table-column type="index" label="排名" width="70" /><el-table-column prop="title" label="短剧" min-width="220"><template #default="scope"><div class="table-series"><span class="table-series__poster"><Film :size="17" /></span><strong>{{ scope.row.title }}</strong></div></template></el-table-column><el-table-column label="播放量"><template #default="scope">{{ formatViews(scope.row.plays) }}</template></el-table-column><el-table-column label="付费转化"><template #default="scope">{{ scope.row.conversion.toFixed(2) }}%</template></el-table-column><el-table-column label="已支付订单" prop="paidOrders" /><el-table-column label="收入"><template #default="scope">${{ scope.row.revenue.toFixed(2) }}</template></el-table-column><template #empty><div class="table-empty"><Film :size="28" /><span>近 7 天暂无播放或支付记录</span></div></template></el-table></section>
    </template>
  </div>
</template>
