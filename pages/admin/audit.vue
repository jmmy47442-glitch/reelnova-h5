<script setup lang="ts">
import { CloudOff, Download, RefreshCw, Search, ShieldAlert } from 'lucide-vue-next';
import { ElMessage } from 'element-plus';
import type { AuditLog, AuditRisk } from '~/types/admin';

definePageMeta({ layout: 'admin' });

const api = useAdminApi();
const keyword = ref('');
const moduleFilter = ref('');
const riskFilter = ref<AuditRisk | ''>('');
const currentPage = ref(1);
const pageSize = 10;
const detailVisible = ref(false);
const activeLog = ref<AuditLog | null>(null);
watch([keyword, moduleFilter, riskFilter], () => {
  currentPage.value = 1;
});
const queryParams = computed(() => ({
  keyword: keyword.value.trim() || undefined,
  module: moduleFilter.value || undefined,
  risk: riskFilter.value || undefined,
  page: currentPage.value,
  pageSize,
}));
const { data, status, error, refresh } = await useAsyncData('admin-audit-real', () => api.getAudit(queryParams.value), { watch: [queryParams] });
const rows = computed(() => data.value?.items || []);
const modules = computed(() => data.value?.modules || []);
const formatDate = (value: string) => new Date(value).toLocaleString('zh-CN', { hour12: false });
const resetFilters = () => { keyword.value = ''; moduleFilter.value = ''; riskFilter.value = ''; currentPage.value = 1; };
const openDetail = (log: AuditLog) => { activeLog.value = log; detailVisible.value = true; };
const exportLogs = () => {
  downloadCsv('reelnova-audit-logs-real.csv', ['时间', '操作人', 'IP', '模块', '操作', '目标', '变更详情', '风险等级'], rows.value.map((log) => [formatDate(log.createdAt), log.actor, log.ip || '', log.module, log.action, log.target, log.detail, log.risk]));
  ElMessage.success(`已导出 ${rows.value.length} 条真实审计日志`);
};
</script>

<template>
  <div>
    <AdminPageHeader title="审计日志" description="追踪高风险操作、操作人、IP 与关键数据变更。">
      <el-button :disabled="!data" @click="exportLogs"><Download :size="16" />导出日志</el-button>
    </AdminPageHeader>
    <section v-if="status === 'pending'" class="admin-panel admin-data-state"><el-skeleton :rows="8" animated /></section>
    <section v-else-if="error || !data" class="admin-panel admin-data-state"><span><CloudOff :size="28" /></span><h2>无法读取真实审计日志</h2><p>Cloudflare D1 尚未连接，或审计日志迁移尚未执行。</p><el-button @click="() => refresh()"><RefreshCw :size="16" />重试连接</el-button></section>
    <template v-else>
      <div class="live-source-line"><span><i class="health-dot ok" />Cloudflare D1</span><strong>更新于 {{ formatDate(data.generatedAt) }}</strong></div>
      <el-alert title="审计日志只读且不可在管理后台删除。生产环境应写入独立、不可篡改的日志存储。" type="info" show-icon :closable="false" class="admin-alert" />
      <section class="admin-panel admin-filter-panel"><div class="admin-filter-row"><el-input v-model="keyword" clearable placeholder="操作人、目标、IP 或变更内容" class="admin-filter-search"><template #prefix><Search :size="16" /></template></el-input><el-select v-model="moduleFilter" placeholder="全部模块" clearable style="width: 150px"><el-option label="全部模块" value="" /><el-option v-for="item in modules" :key="item" :label="item" :value="item" /></el-select><el-select v-model="riskFilter" placeholder="全部风险" clearable style="width: 130px"><el-option label="全部风险" value="" /><el-option label="高风险" value="高风险" /><el-option label="普通" value="普通" /></el-select><el-button text @click="resetFilters">重置</el-button><span class="admin-filter-spacer" /><el-button @click="() => refresh()"><RefreshCw :size="15" />刷新</el-button></div></section>
      <section class="admin-panel admin-table-panel"><el-table :data="rows" row-key="id"><el-table-column label="操作时间" min-width="165"><template #default="scope">{{ formatDate(scope.row.createdAt) }}</template></el-table-column><el-table-column label="操作人 / IP" min-width="170"><template #default="scope"><div class="double-line"><strong>{{ scope.row.actor }}</strong><span>{{ scope.row.ip || '未知 IP' }}</span></div></template></el-table-column><el-table-column prop="module" label="模块" min-width="120" /><el-table-column label="操作 / 目标" min-width="230"><template #default="scope"><div class="double-line"><strong>{{ scope.row.action }}</strong><span>{{ scope.row.target }}</span></div></template></el-table-column><el-table-column prop="detail" label="变更摘要" min-width="260" show-overflow-tooltip /><el-table-column label="风险" width="100"><template #default="scope"><el-tag :type="scope.row.risk === '高风险' ? 'danger' : 'info'">{{ scope.row.risk }}</el-tag></template></el-table-column><el-table-column label="操作" fixed="right" width="80"><template #default="scope"><el-button link type="primary" @click="openDetail(scope.row)">详情</el-button></template></el-table-column><template #empty><div class="table-empty"><Search :size="28" /><span>Cloudflare D1 中没有符合条件的审计日志</span></div></template></el-table><div class="admin-pagination"><span>共 {{ data.total }} 条，只读记录</span><el-pagination v-model:current-page="currentPage" :total="data.total" :page-size="pageSize" background layout="prev, pager, next" /></div></section>
    </template>
    <el-drawer v-model="detailVisible" title="审计日志详情" size="min(520px, 92vw)"><template v-if="activeLog"><div class="audit-detail-icon" :class="{ danger: activeLog.risk === '高风险' }"><ShieldAlert :size="24" /></div><div class="drawer-heading"><div><span>{{ activeLog.module }}</span><strong>{{ activeLog.action }}</strong></div><el-tag :type="activeLog.risk === '高风险' ? 'danger' : 'info'">{{ activeLog.risk }}</el-tag></div><el-descriptions :column="1" border class="admin-descriptions"><el-descriptions-item label="操作目标">{{ activeLog.target }}</el-descriptions-item><el-descriptions-item label="变更详情">{{ activeLog.detail }}</el-descriptions-item><el-descriptions-item label="操作人">{{ activeLog.actor }}</el-descriptions-item><el-descriptions-item label="来源 IP">{{ activeLog.ip || '未知 IP' }}</el-descriptions-item><el-descriptions-item label="操作时间">{{ formatDate(activeLog.createdAt) }}</el-descriptions-item><el-descriptions-item label="日志 ID">{{ activeLog.id }}</el-descriptions-item></el-descriptions></template></el-drawer>
  </div>
</template>
