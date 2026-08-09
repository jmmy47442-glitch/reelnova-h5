<script setup lang="ts">
import { Download, Film, Plus, Search, Upload } from 'lucide-vue-next';
import { ElMessage, ElMessageBox, type UploadFile } from 'element-plus';
import type { AdminSeries, PublishStatus } from '~/composables/useAdminStore';

definePageMeta({ layout: 'admin' });

const { state, addAudit } = useAdminStore();
const keyword = ref('');
const statusFilter = ref('全部状态');
const categoryFilter = ref('全部分类');
const selectedRows = ref<AdminSeries[]>([]);
const dialogVisible = ref(false);
const episodeDrawer = ref(false);
const editingId = ref<string | null>(null);
const selectedSeries = ref<AdminSeries | null>(null);
const uploading = ref(false);
const statuses: PublishStatus[] = ['已上架', '处理中', '草稿', '待发布', '已下架', '版权冻结'];
const categories = computed(() => [...new Set(state.value.series.flatMap((item) => item.genres))]);
const form = reactive({ title: '', description: '', genres: [] as string[], targetRegion: 'United States', freeEpisodeCount: 3, price: 4.99 });

const filteredRows = computed(() => state.value.series.filter((row) => {
  const text = keyword.value.toLowerCase().trim();
  const matchText = !text || `${row.title} ${row.id} ${row.slug}`.toLowerCase().includes(text);
  const matchStatus = statusFilter.value === '全部状态' || row.publishStatus === statusFilter.value;
  const matchCategory = categoryFilter.value === '全部分类' || row.genres.includes(categoryFilter.value);
  return matchText && matchStatus && matchCategory;
}));

const tagType = (status: PublishStatus) => ({ 已上架: 'success', 处理中: 'warning', 草稿: 'info', 待发布: 'primary', 已下架: 'danger', 版权冻结: 'danger' }[status]);
const resetFilters = () => { keyword.value = ''; statusFilter.value = '全部状态'; categoryFilter.value = '全部分类'; };

const openCreate = () => {
  editingId.value = null;
  Object.assign(form, { title: '', description: '', genres: [], targetRegion: 'United States', freeEpisodeCount: 3, price: 4.99 });
  dialogVisible.value = true;
};

const openEdit = (row: AdminSeries) => {
  editingId.value = row.id;
  Object.assign(form, { title: row.title, description: row.description, genres: [...row.genres], targetRegion: row.targetRegion, freeEpisodeCount: row.freeEpisodeCount, price: row.price });
  dialogVisible.value = true;
};

const saveSeries = () => {
  if (!form.title.trim() || !form.genres.length) {
    ElMessage.warning('请填写剧名并至少选择一个分类');
    return;
  }
  if (editingId.value) {
    const row = state.value.series.find((item) => item.id === editingId.value);
    if (!row) return;
    const before = row.title;
    Object.assign(row, { ...form, title: form.title.trim(), genres: [...form.genres], publishAt: new Date().toISOString().slice(0, 10) });
    addAudit({ module: '短剧管理', action: '编辑短剧', target: row.title, detail: `${before} · 内容资料已更新`, risk: '普通' });
    ElMessage.success('短剧资料已保存');
  } else {
    const id = `sr-${String(Date.now()).slice(-6)}`;
    state.value.series.unshift({
      id,
      slug: form.title.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || id,
      title: form.title.trim(), description: form.description, coverUrl: '/posters/vows-vengeance.jpg', genres: [...form.genres], episodeCount: 0,
      freeEpisodeCount: form.freeEpisodeCount, price: form.price, publishStatus: '草稿', publishAt: new Date().toISOString().slice(0, 10), transcodeProgress: 0, targetRegion: form.targetRegion,
    });
    addAudit({ module: '短剧管理', action: '新建短剧', target: form.title.trim(), detail: '创建草稿并等待上传分集', risk: '普通' });
    ElMessage.success('短剧草稿已创建');
  }
  dialogVisible.value = false;
};

const updateStatus = async (rows: AdminSeries[], next: PublishStatus) => {
  if (!rows.length) return ElMessage.warning('请先选择短剧');
  if (next === '已上架' && rows.some((row) => row.episodeCount === 0 || row.transcodeProgress < 100)) {
    return ElMessage.warning('存在未上传分集或转码未完成的短剧，无法上架');
  }
  if (['已下架', '版权冻结'].includes(next)) {
    await ElMessageBox.confirm(`确定将 ${rows.length} 部短剧设为“${next}”吗？该操作会影响前台播放。`, '高风险操作', { type: 'warning', confirmButtonText: '确认执行' });
  }
  rows.forEach((row) => {
    const before = row.publishStatus;
    row.publishStatus = next;
    addAudit({ module: '短剧管理', action: next === '已上架' ? '上架短剧' : '变更发布状态', target: row.title, detail: `${before} → ${next}`, risk: ['已下架', '版权冻结'].includes(next) ? '高风险' : '普通' });
  });
  ElMessage.success(`已更新 ${rows.length} 部短剧`);
};

const duplicate = (row: AdminSeries) => {
  const copy = { ...row, id: `sr-${String(Date.now()).slice(-6)}`, slug: `${row.slug}-copy`, title: `${row.title} Copy`, publishStatus: '草稿' as PublishStatus, genres: [...row.genres] };
  state.value.series.unshift(copy);
  addAudit({ module: '短剧管理', action: '复制短剧', target: copy.title, detail: `来源：${row.id}`, risk: '普通' });
  ElMessage.success('已创建副本草稿');
};

const openEpisodes = (row: AdminSeries) => { selectedSeries.value = row; episodeDrawer.value = true; };
const onFileSelected = (_file: UploadFile) => { uploading.value = true; if (selectedSeries.value) selectedSeries.value.transcodeProgress = 12; };
const startTranscode = () => {
  if (!selectedSeries.value) return;
  if (!uploading.value) return ElMessage.warning('请先选择视频文件');
  const row = selectedSeries.value;
  row.publishStatus = '处理中';
  const timer = window.setInterval(() => {
    row.transcodeProgress = Math.min(100, row.transcodeProgress + 22);
    if (row.transcodeProgress >= 100) {
      window.clearInterval(timer);
      row.episodeCount += 1;
      row.publishStatus = '待发布';
      uploading.value = false;
      addAudit({ module: '短剧管理', action: '上传分集', target: row.title, detail: `第 ${row.episodeCount} 集转码完成`, risk: '普通' });
      ElMessage.success('上传与 HLS 转码已完成');
    }
  }, 350);
};

const exportSeries = () => {
  downloadCsv('reelnova-series.csv', ['ID', '剧名', '分类', '集数', '试看集', '价格(USD)', '状态', '地区'], filteredRows.value.map((row) => [row.id, row.title, row.genres.join('/'), row.episodeCount, row.freeEpisodeCount, row.price, row.publishStatus, row.targetRegion]));
  ElMessage.success('短剧列表已导出');
};
</script>

<template>
  <div>
    <AdminPageHeader title="短剧管理" description="管理短剧资料、分集、素材、试看范围与发布状态。">
      <el-button @click="selectedRows.length ? openEpisodes(selectedRows[0]) : ElMessage.warning('请选择一部短剧')"><Upload :size="16" />上传分集</el-button>
      <el-button type="primary" @click="openCreate"><Plus :size="16" />新建短剧</el-button>
    </AdminPageHeader>

    <section class="admin-panel admin-filter-panel">
      <div class="admin-filter-row">
        <el-input v-model="keyword" clearable placeholder="搜索剧名、ID 或 slug" class="admin-filter-search"><template #prefix><Search :size="16" /></template></el-input>
        <el-select v-model="statusFilter" style="width: 150px"><el-option v-for="item in ['全部状态', ...statuses]" :key="item" :label="item" :value="item" /></el-select>
        <el-select v-model="categoryFilter" style="width: 150px"><el-option v-for="item in ['全部分类', ...categories]" :key="item" :label="item" :value="item" /></el-select>
        <el-button text @click="resetFilters">重置</el-button><span class="admin-filter-spacer" />
        <el-dropdown v-if="selectedRows.length" @command="(command: PublishStatus) => updateStatus(selectedRows, command)"><el-button>批量操作（{{ selectedRows.length }}）</el-button><template #dropdown><el-dropdown-menu><el-dropdown-item command="已上架">批量上架</el-dropdown-item><el-dropdown-item command="已下架">批量下架</el-dropdown-item><el-dropdown-item command="版权冻结" divided>版权冻结</el-dropdown-item></el-dropdown-menu></template></el-dropdown>
        <el-button @click="exportSeries"><Download :size="16" />导出</el-button>
      </div>
    </section>

    <section class="admin-panel admin-table-panel">
      <el-table :data="filteredRows" row-key="id" @selection-change="(rows: AdminSeries[]) => selectedRows = rows">
        <el-table-column type="selection" width="48" />
        <el-table-column label="短剧" min-width="270"><template #default="scope"><div class="series-cell"><img :src="scope.row.coverUrl" alt="" /><div><strong>{{ scope.row.title }}</strong><span>{{ scope.row.id }} · {{ scope.row.episodeCount }} 集 · {{ scope.row.targetRegion }}</span></div></div></template></el-table-column>
        <el-table-column label="分类" min-width="155"><template #default="scope"><el-tag v-for="genre in scope.row.genres.slice(0, 2)" :key="genre" size="small" effect="plain">{{ genre }}</el-tag></template></el-table-column>
        <el-table-column prop="freeEpisodeCount" label="试看集" width="82" />
        <el-table-column label="价格" width="86"><template #default="scope">${{ scope.row.price.toFixed(2) }}</template></el-table-column>
        <el-table-column label="状态" width="118"><template #default="scope"><div class="status-stack"><el-tag :type="tagType(scope.row.publishStatus) as any" effect="light">{{ scope.row.publishStatus }}</el-tag><small v-if="scope.row.publishStatus === '处理中'">{{ scope.row.transcodeProgress }}%</small></div></template></el-table-column>
        <el-table-column prop="publishAt" label="更新时间" width="112" />
        <el-table-column label="操作" fixed="right" width="176"><template #default="scope"><el-button link type="primary" @click="openEdit(scope.row)">编辑</el-button><el-button link @click="openEpisodes(scope.row)">分集</el-button><el-dropdown @command="(command: string) => command === 'copy' ? duplicate(scope.row) : updateStatus([scope.row], command as PublishStatus)"><el-button link>更多</el-button><template #dropdown><el-dropdown-menu><el-dropdown-item command="已上架">上架</el-dropdown-item><el-dropdown-item command="已下架">下架</el-dropdown-item><el-dropdown-item command="copy" divided>复制短剧</el-dropdown-item></el-dropdown-menu></template></el-dropdown></template></el-table-column>
        <template #empty><div class="table-empty"><Film :size="28" /><span>没有符合条件的短剧</span><el-button link type="primary" @click="resetFilters">清除筛选</el-button></div></template>
      </el-table>
      <div class="admin-pagination"><span>共 {{ filteredRows.length }} 条</span><el-pagination background layout="prev, pager, next" :total="filteredRows.length" :page-size="10" /></div>
    </section>

    <el-dialog v-model="dialogVisible" :title="editingId ? '编辑短剧' : '新建短剧'" width="min(680px, 92vw)">
      <el-form label-position="top">
        <el-form-item label="英文剧名" required><el-input v-model="form.title" maxlength="80" show-word-limit placeholder="例如 Vows & Vengeance" /></el-form-item>
        <div class="form-grid"><el-form-item label="分类" required><el-select v-model="form.genres" multiple style="width: 100%" placeholder="选择分类"><el-option v-for="item in categories" :key="item" :label="item" :value="item" /></el-select></el-form-item><el-form-item label="目标地区"><el-select v-model="form.targetRegion" style="width: 100%"><el-option label="United States" value="United States" /><el-option label="Global" value="Global" /><el-option label="Canada" value="Canada" /></el-select></el-form-item></div>
        <div class="form-grid"><el-form-item label="试看集数"><el-input-number v-model="form.freeEpisodeCount" :min="0" :max="10" /></el-form-item><el-form-item label="解锁价格（USD）"><el-input-number v-model="form.price" :min="0" :precision="2" :step="1" /></el-form-item></div>
        <el-form-item label="短剧简介"><el-input v-model="form.description" type="textarea" :rows="4" maxlength="500" show-word-limit /></el-form-item>
      </el-form>
      <template #footer><el-button @click="dialogVisible = false">取消</el-button><el-button type="primary" @click="saveSeries">{{ editingId ? '保存修改' : '创建草稿' }}</el-button></template>
    </el-dialog>

    <el-drawer v-model="episodeDrawer" :title="`${selectedSeries?.title || ''} · 分集管理`" size="min(620px, 92vw)">
      <div v-if="selectedSeries" class="episode-manager">
        <div class="episode-upload-box"><Upload :size="26" /><div><strong>上传下一集视频</strong><span>支持 MP4/MOV，上传后自动校验并生成多码率 HLS</span></div><el-upload :auto-upload="false" :show-file-list="true" :limit="1" accept="video/mp4,video/quicktime" :on-change="onFileSelected"><el-button>选择视频</el-button></el-upload><el-button type="primary" :loading="selectedSeries.publishStatus === '处理中'" @click="startTranscode">开始上传</el-button></div>
        <el-progress v-if="selectedSeries.transcodeProgress < 100 || selectedSeries.publishStatus === '处理中'" :percentage="selectedSeries.transcodeProgress" :status="selectedSeries.transcodeProgress === 100 ? 'success' : undefined" />
        <div class="episode-list"><div class="episode-list__header"><strong>已上传分集</strong><span>{{ selectedSeries.episodeCount }} 集</span></div><div v-for="episode in Math.min(selectedSeries.episodeCount, 12)" :key="episode" class="episode-row"><span class="episode-index">{{ String(episode).padStart(2, '0') }}</span><div><strong>Episode {{ episode }}</strong><span>HLS 1080p / 720p / 480p · 01:{{ 38 + (episode % 20) }}</span></div><el-tag :type="episode <= selectedSeries.freeEpisodeCount ? 'success' : 'info'">{{ episode <= selectedSeries.freeEpisodeCount ? '免费试看' : '付费' }}</el-tag></div></div>
      </div>
    </el-drawer>
  </div>
</template>
