<script setup lang="ts">
import { ArrowDownRight, ArrowUpRight, CircleDollarSign, CloudOff, Download, Eye, Film, Plus, RefreshCw, ShoppingCart, TriangleAlert } from 'lucide-vue-next';
import { ElMessage } from 'element-plus';

definePageMeta({ layout: 'admin' });
const api = useAdminApi();
const { formatViews } = useFormatters();
const chartMode = ref<'播放量' | '收入'>('播放量');
const { data, status, error, refresh } = await useAsyncData('admin-dashboard-real', () => api.getDashboard());

const formatChange = (value: number | null) => value === null ? '新数据' : `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`;
const metrics = computed(() => data.value ? [
  { label: '今日播放量', value: data.value.metrics.plays.value.toLocaleString(), metric: data.value.metrics.plays, icon: Eye, color: 'blue' },
  { label: '今日订单', value: data.value.metrics.orders.value.toLocaleString(), metric: data.value.metrics.orders, icon: ShoppingCart, color: 'green' },
  { label: '已确认收入', value: `$${data.value.metrics.revenue.value.toFixed(2)}`, metric: data.value.metrics.revenue, icon: CircleDollarSign, color: 'orange' },
  { label: '异常订单', value: data.value.metrics.exceptions.value.toLocaleString(), metric: data.value.metrics.exceptions, icon: TriangleAlert, color: 'purple' },
] : []);
const chartValues = computed(() => data.value?.trends.map((point) => chartMode.value === '播放量' ? point.plays : point.revenue) || []);
const chartMax = computed(() => Math.max(1, ...chartValues.value));
const errorMessage = computed(() => (error.value?.data as { data?: { message?: string } } | undefined)?.data?.message || error.value?.statusMessage || 'Cloudflare D1 连接失败');

const downloadReport = () => {
  if (!data.value) return;
  downloadCsv('reelnova-dashboard-real.csv', ['日期', '播放量', '已确认收入(USD)'], data.value.trends.map((point) => [point.date, point.plays, point.revenue.toFixed(2)]));
  ElMessage.success('真实数据报表已导出');
};
</script>

<template>
  <div>
    <AdminPageHeader title="数据概览" description="数据来自 Cloudflare D1；播放事件与 PayPal 已确认订单实时聚合。"><el-button :disabled="!data" @click="downloadReport"><Download :size="16" />下载报表</el-button><el-button type="primary" @click="navigateTo('/admin/series')"><Plus :size="16" />创建短剧</el-button></AdminPageHeader>

    <section v-if="status === 'pending'" class="admin-panel admin-data-state"><el-skeleton :rows="8" animated /></section>
    <section v-else-if="error || !data" class="admin-panel admin-data-state"><span><CloudOff :size="28" /></span><h2>Cloudflare 尚未连接</h2><p>{{ errorMessage }}</p><div><el-button @click="() => refresh()"><RefreshCw :size="16" />重试连接</el-button><NuxtLink to="/admin/system" class="el-button el-button--primary">检查配置</NuxtLink></div></section>

    <template v-else>
      <div class="live-source-line"><span><i class="health-dot ok" />{{ data.source }}</span><strong>更新于 {{ new Date(data.generatedAt).toLocaleString('zh-CN', { hour12: false }) }} · {{ data.timezone }}</strong></div>
      <section class="admin-metric-grid"><article v-for="item in metrics" :key="item.label" class="admin-panel admin-metric"><div class="admin-metric__top"><span class="admin-metric__icon" :class="`is-${item.color}`"><component :is="item.icon" :size="21" /></span><span class="admin-metric__change" :class="item.metric.changePercent !== null && item.metric.changePercent < 0 ? 'down' : 'up'"><ArrowDownRight v-if="item.metric.changePercent !== null && item.metric.changePercent < 0" :size="14" /><ArrowUpRight v-else :size="14" />{{ formatChange(item.metric.changePercent) }}</span></div><span>{{ item.label }}</span><strong>{{ item.value }}</strong><small>昨日同期 {{ item.metric.previousValue.toLocaleString() }}</small></article></section>
      <section class="admin-dashboard-grid"><article class="admin-panel admin-chart-panel"><div class="admin-panel__header"><div><h2>播放与收入趋势</h2><p>最近 14 天真实记录</p></div><el-segmented v-model="chartMode" :options="['播放量', '收入']" size="small" /></div><div class="bar-chart" aria-label="最近十四天播放与收入趋势"><div v-for="(point, index) in data.trends" :key="point.date" class="bar-chart__column"><span :style="{ height: `${Math.max(2, chartValues[index] / chartMax * 100)}%` }" :title="chartMode === '播放量' ? `${point.plays} 次播放` : `$${point.revenue.toFixed(2)}`" /><small>{{ index % 2 === 0 ? point.date.slice(5) : '' }}</small></div></div></article><article class="admin-panel admin-health-panel"><div class="admin-panel__header"><div><h2>数据链路</h2><p>Cloudflare 与 PayPal 状态</p></div><span class="admin-status-ok">D1 已连接</span></div><ul><li><span><i class="health-dot ok" />Cloudflare D1</span><strong>正常</strong></li><li><span><i class="health-dot" :class="data.health.lastWebhookAt ? 'ok' : 'warning'" />最近 PayPal Webhook</span><strong>{{ data.health.lastWebhookAt ? new Date(data.health.lastWebhookAt).toLocaleString('zh-CN', { hour12: false }) : '暂无' }}</strong></li><li><span><i class="health-dot warning" />待确认订单</span><strong>{{ data.health.pendingOrders }} 笔</strong></li><li><span><i class="health-dot" :class="data.health.failedWebhooks ? 'warning' : 'ok'" />Webhook 处理失败</span><strong>{{ data.health.failedWebhooks }} 条</strong></li></ul></article></section>
      <section class="admin-panel admin-table-panel"><div class="admin-panel__header"><div><h2>热门短剧</h2><p>近 7 天，按已确认收入排序</p></div><NuxtLink to="/admin/orders">查看订单</NuxtLink></div><el-table :data="data.topSeries"><el-table-column type="index" label="排名" width="70" /><el-table-column prop="title" label="短剧" min-width="220"><template #default="scope"><div class="table-series"><span class="table-series__poster"><Film :size="17" /></span><strong>{{ scope.row.title }}</strong></div></template></el-table-column><el-table-column label="播放量"><template #default="scope">{{ formatViews(scope.row.plays) }}</template></el-table-column><el-table-column label="付费转化"><template #default="scope">{{ scope.row.conversion.toFixed(2) }}%</template></el-table-column><el-table-column label="已支付订单" prop="paidOrders" /><el-table-column label="收入"><template #default="scope">${{ scope.row.revenue.toFixed(2) }}</template></el-table-column><template #empty><div class="table-empty"><Film :size="28" /><span>近 7 天暂无播放或支付记录</span></div></template></el-table></section>
    </template>
  </div>
</template>
