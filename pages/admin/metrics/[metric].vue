<script setup lang="ts">
import { ArrowLeft, CircleDollarSign, CloudOff, Eye, RefreshCw, Search, ShoppingCart, TriangleAlert } from 'lucide-vue-next';
import type { AdminMetricOrderItem, AdminMetricPlaybackItem, DashboardMetricKey, PersistedOrderStatus } from '~/types/admin';

definePageMeta({
  layout: 'admin',
  keepalive: true,
  validate: (route) => ['plays', 'orders', 'revenue', 'exceptions'].includes(String(route.params.metric)),
});

const route = useRoute();
const api = useAdminApi();
const metric = computed(() => String(route.params.metric) as DashboardMetricKey);
const keyword = ref('');
const appliedKeyword = ref('');
const page = ref(1);
const pageSize = ref(20);
const requestQuery = computed(() => ({
  page: page.value,
  pageSize: pageSize.value,
  keyword: appliedKeyword.value || undefined,
}));
const dataKey = computed(() => `admin-metric-detail-real-${metric.value}`);
const { data, status, error, refresh } = useLazyAsyncData(
  dataKey,
  () => api.getMetricDetail(metric.value, requestQuery.value),
  { watch: [requestQuery] },
);

const navigation = [
  { key: 'plays' as const, label: '今日播放量', icon: Eye },
  { key: 'orders' as const, label: '今日订单', icon: ShoppingCart },
  { key: 'revenue' as const, label: '已确认收入', icon: CircleDollarSign },
  { key: 'exceptions' as const, label: '异常订单', icon: TriangleAlert },
];
const activeNavigation = computed(() => navigation.find((item) => item.key === metric.value) || navigation[0]);
const playbackRows = computed(() => data.value?.kind === 'playback' ? data.value.items as AdminMetricPlaybackItem[] : []);
const orderRows = computed(() => data.value?.kind === 'order' ? data.value.items as AdminMetricOrderItem[] : []);
const pageTitle = computed(() => data.value?.title || `${activeNavigation.value.label}明细`);
const metricValue = computed(() => data.value
  ? metric.value === 'revenue' ? `$${data.value.value.toFixed(2)}` : data.value.value.toLocaleString()
  : '--');
const metricUnit = computed(() => metric.value === 'revenue' ? `${data.value?.recordCount || 0} 笔已确认订单` : `${data.value?.recordCount || 0} 条记录`);
const statusLabels: Record<PersistedOrderStatus, string> = {
  pending: '待支付', processing: '处理中', paid: '已支付', failed: '支付失败', cancelled: '已取消',
  refunding: '退款中', refunded: '已退款', risk_review: '风控审核',
};
const statusType = (value: PersistedOrderStatus) => ({
  paid: 'success', processing: 'warning', pending: 'info', failed: 'danger', cancelled: 'info',
  refunding: 'primary', refunded: 'info', risk_review: 'danger',
}[value]);
const formatTime = (value: string) => new Date(value).toLocaleString('zh-CN', {
  timeZone: 'UTC',
  hour12: false,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});
const compactId = (value: string) => value.length > 18 ? `${value.slice(0, 8)}...${value.slice(-6)}` : value;
const applySearch = () => {
  appliedKeyword.value = keyword.value.trim();
  page.value = 1;
};
const clearSearch = () => {
  keyword.value = '';
  appliedKeyword.value = '';
  page.value = 1;
};
watch(metric, () => clearSearch());
</script>

<template>
  <div>
    <AdminPageHeader :title="pageTitle" :description="data?.description || '查看当日指标对应的原始业务记录。'">
      <el-button @click="navigateTo('/admin')"><ArrowLeft :size="16" />返回概览</el-button>
      <el-button :loading="status === 'pending'" @click="() => refresh()"><RefreshCw :size="16" />刷新</el-button>
    </AdminPageHeader>

    <nav class="metric-detail-tabs" aria-label="数据指标明细">
      <NuxtLink v-for="item in navigation" :key="item.key" :to="`/admin/metrics/${item.key}`" :class="{ 'is-active': metric === item.key }">
        <component :is="item.icon" :size="16" />
        <span>{{ item.label }}</span>
      </NuxtLink>
    </nav>

    <section v-if="status === 'pending' && !data" class="admin-panel admin-data-state"><el-skeleton :rows="8" animated /></section>
    <section v-else-if="error || !data" class="admin-panel admin-data-state">
      <span><CloudOff :size="28" /></span><h2>无法读取指标明细</h2><p>Cloudflare D1 尚未连接或数据表未初始化。</p>
      <el-button @click="() => refresh()"><RefreshCw :size="16" />重试连接</el-button>
    </section>

    <template v-else>
      <section class="admin-panel metric-detail-summary" :class="`is-${metric}`">
        <div class="metric-detail-summary__icon"><component :is="activeNavigation.icon" :size="22" /></div>
        <div class="metric-detail-summary__value"><span>{{ activeNavigation.label }}</span><strong>{{ metricValue }}</strong><small>{{ metricUnit }}</small></div>
        <dl>
          <div><dt>统计区间</dt><dd>{{ data.range.label }} (UTC)</dd></div>
          <div><dt>数据源</dt><dd><i class="health-dot ok" />Cloudflare D1</dd></div>
          <div><dt>更新时间</dt><dd>{{ formatTime(data.generatedAt) }} UTC</dd></div>
        </dl>
      </section>

      <section class="admin-panel admin-filter-panel metric-detail-filter">
        <form class="admin-filter-row" role="search" @submit.prevent="applySearch">
          <el-input v-model="keyword" clearable aria-label="搜索指标明细" :placeholder="data.kind === 'playback' ? '搜索短剧、会话或用户' : '搜索订单号、用户、短剧或 PayPal ID'" class="admin-filter-search" @clear="clearSearch">
            <template #prefix><Search :size="16" /></template>
          </el-input>
          <el-button type="primary" native-type="submit"><Search :size="15" />搜索</el-button>
          <el-button v-if="appliedKeyword" text @click="clearSearch">清除</el-button>
          <span class="admin-filter-spacer" />
          <span class="metric-detail-filter__count">共 {{ data.recordCount.toLocaleString() }} 条</span>
        </form>
      </section>

      <section class="admin-panel admin-table-panel metric-detail-table" :aria-busy="status === 'pending'">
        <el-table v-if="data.kind === 'playback'" v-loading="status === 'pending'" :data="playbackRows" row-key="eventId">
          <el-table-column label="短剧 / 集数" min-width="230"><template #default="scope"><div class="double-line"><strong>{{ scope.row.seriesTitle }}</strong><span>第 {{ scope.row.episodeNo }} 集</span></div></template></el-table-column>
          <el-table-column label="用户 / 会话" min-width="220"><template #default="scope"><div class="double-line"><strong>{{ scope.row.email || compactId(scope.row.userId) }}</strong><span :title="scope.row.sessionId">会话 {{ compactId(scope.row.sessionId) }}</span></div></template></el-table-column>
          <el-table-column label="地区" width="90"><template #default="scope">{{ scope.row.country || '未知' }}</template></el-table-column>
          <el-table-column label="起播位置" width="106"><template #default="scope">{{ scope.row.positionSeconds }} 秒</template></el-table-column>
          <el-table-column label="视频时长" width="106"><template #default="scope">{{ scope.row.durationSeconds ? `${scope.row.durationSeconds} 秒` : '—' }}</template></el-table-column>
          <el-table-column label="播放时间 (UTC)" min-width="178"><template #default="scope">{{ formatTime(scope.row.occurredAt) }}</template></el-table-column>
          <template #empty><div class="table-empty"><Eye :size="28" /><span>今日没有符合条件的播放记录，请检查搜索词或清除筛选</span></div></template>
        </el-table>

        <el-table v-else v-loading="status === 'pending'" :data="orderRows" row-key="orderNo">
          <el-table-column label="本地订单号" min-width="180"><template #default="scope"><strong class="metric-order-id">{{ scope.row.orderNo }}</strong></template></el-table-column>
          <el-table-column label="短剧 / 用户" min-width="230"><template #default="scope"><div class="double-line"><strong>{{ scope.row.seriesTitle }}</strong><span>{{ scope.row.email || '未提供邮箱' }} · {{ scope.row.country || '未知地区' }}</span></div></template></el-table-column>
          <el-table-column label="金额" width="104"><template #default="scope"><strong>${{ scope.row.amount.toFixed(2) }}</strong></template></el-table-column>
          <el-table-column label="状态" width="110"><template #default="scope"><el-tag :type="statusType(scope.row.status) as any">{{ statusLabels[scope.row.status as PersistedOrderStatus] }}</el-tag></template></el-table-column>
          <el-table-column label="PayPal / Capture" min-width="190"><template #default="scope"><div class="double-line"><strong>{{ scope.row.paypalOrderId || '—' }}</strong><span>{{ scope.row.captureId || '暂无 Capture ID' }}</span></div></template></el-table-column>
          <el-table-column v-if="metric === 'exceptions'" label="异常说明" min-width="180"><template #default="scope">{{ scope.row.note || '暂无服务端备注' }}</template></el-table-column>
          <el-table-column :label="metric === 'revenue' ? '确认时间 (UTC)' : '创建时间 (UTC)'" min-width="178"><template #default="scope">{{ formatTime(scope.row.occurredAt) }}</template></el-table-column>
          <template #empty><div class="table-empty"><ShoppingCart :size="28" /><span>今日没有符合条件的订单记录，请检查搜索词或清除筛选</span></div></template>
        </el-table>

        <div class="admin-pagination metric-detail-pagination">
          <span>第 {{ data.page }} 页，共 {{ data.recordCount.toLocaleString() }} 条</span>
          <el-pagination v-model:current-page="page" v-model:page-size="pageSize" :total="data.recordCount" :page-sizes="[20, 50, 100]" layout="sizes, prev, pager, next" background />
        </div>
      </section>
    </template>
  </div>
</template>
