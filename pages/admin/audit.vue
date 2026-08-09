<script setup lang="ts">
import { Download, Search, ShieldAlert } from 'lucide-vue-next';
import { ElMessage } from 'element-plus';
import type { AuditLog } from '~/composables/useAdminStore';

definePageMeta({ layout: 'admin' });

const { state } = useAdminStore();
const keyword = ref('');
const moduleFilter = ref('全部模块');
const riskFilter = ref('全部风险');
const detailVisible = ref(false);
const activeLog = ref<AuditLog | null>(null);
const modules = computed(() => [...new Set(state.value.auditLogs.map((item) => item.module))]);
const rows = computed(() => state.value.auditLogs.filter((log) => {
  const text = keyword.value.toLowerCase().trim();
  return (!text || `${log.actor} ${log.action} ${log.target} ${log.detail} ${log.ip}`.toLowerCase().includes(text)) && (moduleFilter.value === '全部模块' || log.module === moduleFilter.value) && (riskFilter.value === '全部风险' || log.risk === riskFilter.value);
}));

const openDetail = (log: AuditLog) => { activeLog.value = log; detailVisible.value = true; };
const exportLogs = () => {
  downloadCsv('reelnova-audit-logs.csv', ['时间', '操作人', 'IP', '模块', '操作', '目标', '变更详情', '风险等级'], rows.value.map((log) => [log.createdAt, log.actor, log.ip, log.module, log.action, log.target, log.detail, log.risk]));
  ElMessage.success(`已导出 ${rows.value.length} 条审计日志`);
};
</script>

<template>
  <div>
    <AdminPageHeader title="审计日志" description="追踪高风险操作、操作人、IP 与关键数据变更。"><el-button @click="exportLogs"><Download :size="16" />导出日志</el-button></AdminPageHeader>
    <el-alert title="审计日志只读且不可在管理后台删除。生产环境应写入独立、不可篡改的日志存储。" type="info" show-icon :closable="false" class="admin-alert" />
    <section class="admin-panel admin-filter-panel"><div class="admin-filter-row"><el-input v-model="keyword" clearable placeholder="操作人、目标、IP 或变更内容" class="admin-filter-search"><template #prefix><Search :size="16" /></template></el-input><el-select v-model="moduleFilter" style="width: 150px"><el-option v-for="item in ['全部模块', ...modules]" :key="item" :label="item" :value="item" /></el-select><el-select v-model="riskFilter" style="width: 130px"><el-option label="全部风险" value="全部风险" /><el-option label="高风险" value="高风险" /><el-option label="普通" value="普通" /></el-select><el-button text @click="keyword = ''; moduleFilter = '全部模块'; riskFilter = '全部风险'">重置</el-button></div></section>
    <section class="admin-panel admin-table-panel"><el-table :data="rows" row-key="id"><el-table-column prop="createdAt" label="操作时间" min-width="165" /><el-table-column label="操作人 / IP" min-width="150"><template #default="scope"><div class="double-line"><strong>{{ scope.row.actor }}</strong><span>{{ scope.row.ip }}</span></div></template></el-table-column><el-table-column prop="module" label="模块" min-width="120" /><el-table-column label="操作 / 目标" min-width="230"><template #default="scope"><div class="double-line"><strong>{{ scope.row.action }}</strong><span>{{ scope.row.target }}</span></div></template></el-table-column><el-table-column prop="detail" label="变更摘要" min-width="260" show-overflow-tooltip /><el-table-column label="风险" width="100"><template #default="scope"><el-tag :type="scope.row.risk === '高风险' ? 'danger' : 'info'">{{ scope.row.risk }}</el-tag></template></el-table-column><el-table-column label="操作" fixed="right" width="80"><template #default="scope"><el-button link type="primary" @click="openDetail(scope.row)">详情</el-button></template></el-table-column></el-table><div class="admin-pagination"><span>共 {{ rows.length }} 条，只读记录</span></div></section>
    <el-drawer v-model="detailVisible" title="审计日志详情" size="min(520px, 92vw)"><template v-if="activeLog"><div class="audit-detail-icon" :class="{ danger: activeLog.risk === '高风险' }"><ShieldAlert :size="24" /></div><div class="drawer-heading"><div><span>{{ activeLog.module }}</span><strong>{{ activeLog.action }}</strong></div><el-tag :type="activeLog.risk === '高风险' ? 'danger' : 'info'">{{ activeLog.risk }}</el-tag></div><el-descriptions :column="1" border class="admin-descriptions"><el-descriptions-item label="操作目标">{{ activeLog.target }}</el-descriptions-item><el-descriptions-item label="变更详情">{{ activeLog.detail }}</el-descriptions-item><el-descriptions-item label="操作人">{{ activeLog.actor }}</el-descriptions-item><el-descriptions-item label="来源 IP">{{ activeLog.ip }}</el-descriptions-item><el-descriptions-item label="操作时间">{{ activeLog.createdAt }}</el-descriptions-item><el-descriptions-item label="日志 ID">{{ activeLog.id }}</el-descriptions-item></el-descriptions></template></el-drawer>
  </div>
</template>
