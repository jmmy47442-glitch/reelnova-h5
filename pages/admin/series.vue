<script setup lang="ts">
import { CloudOff, Download, Eye, Film, FileVideo, Plus, RefreshCw, Search, Upload } from 'lucide-vue-next';
import Hls from 'hls.js';
import { createFile as createMp4File } from 'mp4box';
import { ElMessage, ElMessageBox, type UploadFile, type UploadFiles } from 'element-plus';
import type { AdminEpisode, MediaUploadPart, MediaUploadSession } from '~/types/admin';
import type { AdminSeries, PublishStatus } from '~/composables/useAdminStore';

definePageMeta({ layout: 'admin' });

const { state } = useAdminStore();
const api = useAdminApi();
const keyword = ref('');
const statusFilter = ref('全部状态');
const categoryFilter = ref('全部分类');
const selectedRows = ref<AdminSeries[]>([]);
const dialogVisible = ref(false);
const episodeDrawer = ref(false);
const editingId = ref<string | null>(null);
const selectedSeries = ref<AdminSeries | null>(null);
const uploading = ref(false);
const loading = ref(true);
const loadError = ref(false);
const saving = ref(false);
const selectedFiles = ref<File[]>([]);
const episodeStart = ref(1);
const uploadProgress = ref(0);
const uploadLabel = ref('');
const mediaAvailable = ref(false);
const mediaAvailabilityLoading = ref(true);
const episodes = ref<AdminEpisode[]>([]);
const episodesLoading = ref(false);
const episodeError = ref('');
const previewVisible = ref(false);
const previewVideo = ref<HTMLVideoElement | null>(null);
let episodePoll: ReturnType<typeof setInterval> | undefined;
let previewHls: Hls | undefined;
const statuses: PublishStatus[] = ['已上架', '处理中', '草稿', '待发布', '已下架', '版权冻结'];
const categories = computed(() => [...new Set([
  ...state.value.taxonomy.filter((item) => item.type === '分类' && item.enabled).map((item) => item.name),
  ...state.value.series.flatMap((item) => item.genres),
])]);
const form = reactive({ title: '', description: '', genres: [] as string[], targetRegion: 'United States', freeEpisodeCount: 3, price: 4.99 });

const loadSeries = async () => {
  loading.value = true;
  loadError.value = false;
  try {
    const [series, taxonomy] = await Promise.all([api.getSeries(), api.getTaxonomy()]);
    state.value.series = series.items;
    state.value.taxonomy = taxonomy.items;
  } catch {
    loadError.value = true;
  } finally {
    loading.value = false;
  }
};

const loadMediaAvailability = async () => {
  mediaAvailabilityLoading.value = true;
  try { mediaAvailable.value = (await api.getConnection()).cloudflare.mediaConfigured; }
  catch { mediaAvailable.value = false; }
  finally { mediaAvailabilityLoading.value = false; }
};

onMounted(() => { void loadSeries(); void loadMediaAvailability(); });

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

const saveSeries = async () => {
  if (!form.title.trim() || !form.genres.length) {
    ElMessage.warning('请填写剧名并至少选择一个分类');
    return;
  }
  saving.value = true;
  const input = { ...form, title: form.title.trim(), description: form.description.trim(), genres: [...form.genres] };
  try {
    if (editingId.value) {
      const updated = await api.updateSeries(editingId.value, input);
      const index = state.value.series.findIndex((item) => item.id === updated.id);
      if (index >= 0) state.value.series[index] = updated;
      ElMessage.success('短剧资料已保存并同步到服务端');
    } else {
      state.value.series.unshift(await api.createSeries(input));
      ElMessage.success('短剧草稿已创建');
    }
    dialogVisible.value = false;
  } catch (reason: any) {
    ElMessage.error(reason?.data?.statusMessage || '短剧资料保存失败');
  } finally {
    saving.value = false;
  }
};

const updateStatus = async (rows: AdminSeries[], next: PublishStatus) => {
  if (!rows.length) return ElMessage.warning('请先选择短剧');
  if (next === '已上架' && rows.some((row) => row.episodeCount === 0 || row.transcodeProgress < 100)) {
    return ElMessage.warning('存在未上传分集或转码未完成的短剧，无法上架');
  }
  if (['已下架', '版权冻结'].includes(next)) {
    await ElMessageBox.confirm(`确定将 ${rows.length} 部短剧设为“${next}”吗？该操作会影响前台播放。`, '高风险操作', { type: 'warning', confirmButtonText: '确认执行' });
  }
  try {
    const updated = await Promise.all(rows.map((row) => api.updateSeriesStatus(row.id, next)));
    updated.forEach((item) => {
      const index = state.value.series.findIndex((row) => row.id === item.id);
      if (index >= 0) state.value.series[index] = item;
    });
    selectedRows.value = [];
    ElMessage.success(`已更新 ${rows.length} 部短剧`);
  } catch (reason: any) {
    await loadSeries();
    ElMessage.error(reason?.data?.statusMessage || '发布状态更新失败');
  }
};

const duplicate = async (row: AdminSeries) => {
  try {
    state.value.series.unshift(await api.duplicateSeries(row.id));
    ElMessage.success('已创建副本草稿');
  } catch (reason: any) {
    ElMessage.error(reason?.data?.statusMessage || '复制短剧失败');
  }
};

const removeSeries = async (row: AdminSeries) => {
  await ElMessageBox.confirm(`确定删除“${row.title}”吗？内容将下架并软删除，历史订单仍会保留。`, '删除短剧', { type: 'warning', confirmButtonText: '确认删除' });
  try {
    const result = await api.deleteSeries(row.id);
    state.value.series = state.value.series.filter((item) => item.id !== row.id);
    ElMessage.success(result.retainedOrderCount ? `已删除，保留 ${result.retainedOrderCount} 笔历史订单` : '短剧已删除');
  } catch (reason: any) { ElMessage.error(reason?.data?.statusMessage || '短剧删除失败'); }
};

const formatBytes = (value: number | null) => {
  if (!value) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / 1024 ** index).toFixed(index > 1 ? 1 : 0)} ${units[index]}`;
};
const formatDuration = (value: number) => `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, '0')}`;
const mediaStatus = (episode: AdminEpisode) => ({
  waiting_upload: ['待上传', 'info'], uploading: ['上传中', 'warning'], validating: ['校验中', 'warning'],
  processing: [`转码 ${episode.transcodeProgress}%`, 'warning'], ready: ['可发布', 'success'], failed: ['处理失败', 'danger'],
}[episode.videoStatus] || ['未知', 'info']) as [string, string];

const loadEpisodes = async (showLoading = true) => {
  if (!selectedSeries.value) return;
  if (showLoading) episodesLoading.value = true;
  episodeError.value = '';
  try {
    episodes.value = (await api.getEpisodes(selectedSeries.value.id)).items;
    const row = state.value.series.find((item) => item.id === selectedSeries.value?.id);
    if (row) {
      row.episodeCount = episodes.value.length;
      row.transcodeProgress = episodes.value.length
        ? Math.round(episodes.value.reduce((sum, episode) => sum + episode.transcodeProgress, 0) / episodes.value.length)
        : 0;
      selectedSeries.value = row;
    }
  } catch (reason: any) {
    episodeError.value = reason?.data?.statusMessage || '无法读取分集和媒体任务';
  } finally { episodesLoading.value = false; }
};

const openEpisodes = (row: AdminSeries) => {
  selectedSeries.value = row;
  episodeStart.value = Math.max(1, row.episodeCount + 1);
  selectedFiles.value = [];
  uploadProgress.value = 0;
  episodeDrawer.value = true;
  void loadEpisodes();
};

const onFileSelected = (_file: UploadFile, files: UploadFiles) => {
  selectedFiles.value = files.reduce<File[]>((result, item) => {
    if (item.raw) result.push(item.raw);
    return result;
  }, []);
};

interface ResumeState { session: MediaUploadSession; parts: MediaUploadPart[] }
interface MediaProbe { durationSeconds: number; width: number; height: number; hasVideo: true; hasAudio: true }
const resumeKey = (seriesId: string, episodeNo: number, file: File) => `reelnova-upload:${seriesId}:${episodeNo}:${file.name}:${file.size}:${file.lastModified}`;
const readResume = (key: string) => {
  try {
    const value = JSON.parse(localStorage.getItem(key) || '') as ResumeState;
    return value.session?.id && Date.parse(value.session.expiresAt) > Date.now() ? value : null;
  } catch { return null; }
};
const writeResume = (key: string, value: ResumeState) => localStorage.setItem(key, JSON.stringify(value));

const inspectMedia = (file: File) => new Promise<MediaProbe>(async (resolve, reject) => {
  const parser = createMp4File();
  let settled = false;
  const finish = (callback: () => void) => { if (!settled) { settled = true; callback(); } };
  parser.onError = (_module, message) => finish(() => reject(new Error(`无法解析媒体容器：${message}`)));
  parser.onReady = (info) => finish(() => {
    const videoTrack = info.videoTracks[0];
    const audioTrack = info.audioTracks[0];
    if (!videoTrack) return reject(new Error(`${file.name} 缺少视频轨道`));
    if (!audioTrack) return reject(new Error(`${file.name} 缺少音频轨道`));
    const durationSeconds = info.timescale ? info.duration / info.timescale : 0;
    const width = Math.round(videoTrack.video?.width || videoTrack.track_width || 0);
    const height = Math.round(videoTrack.video?.height || videoTrack.track_height || 0);
    if (!durationSeconds || durationSeconds > 6 * 60 * 60 || !width || !height) return reject(new Error(`${file.name} 的时长或画面尺寸无效`));
    resolve({ durationSeconds, width, height, hasVideo: true, hasAudio: true });
  });
  try {
    const chunkSize = 2 * 1024 * 1024;
    let nextOffset = 0;
    const visited = new Set<number>();
    for (let reads = 0; reads < 64 && !settled; reads += 1) {
      const offset = Math.max(0, Math.min(nextOffset, Math.max(0, file.size - 8)));
      if (visited.has(offset)) break;
      visited.add(offset);
      const buffer = await file.slice(offset, Math.min(file.size, offset + chunkSize)).arrayBuffer() as ArrayBuffer & { fileStart: number };
      buffer.fileStart = offset;
      nextOffset = parser.appendBuffer(buffer, offset + buffer.byteLength >= file.size);
      if (!Number.isFinite(nextOffset) || nextOffset < 0) break;
    }
    if (!settled) parser.flush();
    if (!settled) finish(() => reject(new Error(`${file.name} 的媒体元数据不完整`)));
  } catch (error) { finish(() => reject(error)); }
});

const uploadPart = (url: string, token: string, blob: Blob, onProgress: (loaded: number) => void) => new Promise<MediaUploadPart>((resolve, reject) => {
  const request = new XMLHttpRequest();
  request.open('PUT', url);
  request.setRequestHeader('Authorization', `Bearer ${token}`);
  request.setRequestHeader('Content-Type', 'application/octet-stream');
  request.upload.onprogress = (event) => onProgress(event.loaded);
  request.onerror = () => reject(new Error('分片网络请求失败'));
  request.onload = () => {
    if (request.status < 200 || request.status >= 300) return reject(new Error(`分片上传失败 (${request.status})`));
    try { resolve(JSON.parse(request.responseText) as MediaUploadPart); }
    catch { reject(new Error('媒体 Worker 返回了无效响应')); }
  };
  request.send(blob);
});

const uploadOne = async (file: File, episodeNo: number, completedBefore: number, totalBytes: number) => {
  if (!selectedSeries.value) return;
  const key = resumeKey(selectedSeries.value.id, episodeNo, file);
  let resume = readResume(key);
  if (!resume) {
    uploadLabel.value = `正在校验 Episode ${episodeNo} · ${file.name}`;
    const probe = await inspectMedia(file);
    const session = await api.createEpisodeUpload(selectedSeries.value.id, {
      episodeNo, title: `Episode ${episodeNo}`, fileName: file.name,
      contentType: file.type || (file.name.toLowerCase().endsWith('.mov') ? 'video/quicktime' : 'video/mp4'), fileSizeBytes: file.size,
      ...probe,
    });
    resume = { session, parts: [] };
    writeResume(key, resume);
  }
  const { session } = resume;
  const parts = new Map(resume.parts.map((part) => [part.partNumber, part]));
  const partCount = Math.ceil(file.size / session.partSizeBytes);
  let completedBytes = [...parts.keys()].reduce((sum, partNumber) => sum + Math.min(session.partSizeBytes, file.size - (partNumber - 1) * session.partSizeBytes), 0);
  for (let partNumber = 1; partNumber <= partCount; partNumber += 1) {
    if (parts.has(partNumber)) continue;
    const start = (partNumber - 1) * session.partSizeBytes;
    const blob = file.slice(start, Math.min(file.size, start + session.partSizeBytes));
    let uploaded: MediaUploadPart | undefined;
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3 && !uploaded; attempt += 1) {
      try {
        uploaded = await uploadPart(`${session.uploadUrl}/parts/${partNumber}`, session.uploadToken, blob, (loaded) => {
          uploadProgress.value = Math.min(99, Math.round((completedBefore + completedBytes + loaded) / totalBytes * 100));
        });
      } catch (error) { lastError = error; }
    }
    if (!uploaded) throw lastError || new Error('分片上传失败');
    parts.set(partNumber, uploaded);
    completedBytes += blob.size;
    resume.parts = [...parts.values()].sort((left, right) => left.partNumber - right.partNumber);
    writeResume(key, resume);
    void api.reportUploadProgress(session.id, completedBytes).catch(() => undefined);
  }
  const completion = await api.completeEpisodeUpload(session.id, [...parts.values()]);
  localStorage.removeItem(key);
  if (completion.status === 'failed') throw new Error(completion.errorMessage || '原片已保留，但 Stream 转码提交失败，请在分集列表重试');
};

const startTranscode = async () => {
  if (!selectedSeries.value) return;
  if (!mediaAvailable.value) return ElMessage.warning('R2/Stream 媒体链路尚未配置');
  if (!selectedFiles.value.length) return ElMessage.warning('请选择一个或多个 MP4/MOV 文件');
  const invalid = selectedFiles.value.find((file) => !/\.(mp4|mov)$/i.test(file.name) || file.size < 1024 || file.size > 20 * 1024 ** 3);
  if (invalid) return ElMessage.error(`${invalid.name} 不是有效的 MP4/MOV 文件，或文件超过 20 GB`);
  uploading.value = true;
  uploadProgress.value = 0;
  const totalBytes = selectedFiles.value.reduce((sum, file) => sum + file.size, 0);
  let completedBefore = 0;
  try {
    for (let index = 0; index < selectedFiles.value.length; index += 1) {
      const file = selectedFiles.value[index];
      uploadLabel.value = `Episode ${episodeStart.value + index} · ${file.name}`;
      await uploadOne(file, episodeStart.value + index, completedBefore, totalBytes);
      completedBefore += file.size;
    }
    uploadProgress.value = 100;
    selectedFiles.value = [];
    ElMessage.success('原片已写入 R2，Stream 转码任务已提交');
    await Promise.all([loadEpisodes(), loadSeries()]);
  } catch (reason) {
    const message = reason instanceof Error ? reason.message : '上传中断';
    ElMessage.error(message.includes('原片已保留') ? message : `${message}，重新点击可从已完成分片继续`);
    await loadEpisodes(false);
  } finally { uploading.value = false; }
};

const retryTranscode = async (episode: AdminEpisode) => {
  if (!episode.mediaAssetId) return;
  try {
    await api.retryTranscode(episode.mediaAssetId);
    ElMessage.success('已重新提交转码任务');
    await loadEpisodes();
  } catch (reason: any) { ElMessage.error(reason?.data?.statusMessage || '转码重试失败'); }
};

const openPreview = async (episode: AdminEpisode) => {
  if (!episode.previewUrl) return;
  previewVisible.value = true;
  await nextTick();
  if (!previewVideo.value) return;
  previewHls?.destroy();
  if (previewVideo.value.canPlayType('application/vnd.apple.mpegurl')) previewVideo.value.src = episode.previewUrl;
  else if (Hls.isSupported()) {
    previewHls = new Hls();
    previewHls.loadSource(episode.previewUrl);
    previewHls.attachMedia(previewVideo.value);
  }
};

watch(episodeDrawer, (open) => {
  if (episodePoll) clearInterval(episodePoll);
  if (open) episodePoll = setInterval(() => {
    if (episodes.value.some((episode) => ['processing', 'validating'].includes(episode.videoStatus))) void loadEpisodes(false);
  }, 5000);
});
watch(previewVisible, (open) => { if (!open) { previewHls?.destroy(); previewHls = undefined; } });
onBeforeUnmount(() => { if (episodePoll) clearInterval(episodePoll); previewHls?.destroy(); });

const exportSeries = () => {
  downloadCsv('reelnova-series.csv', ['ID', '剧名', '分类', '集数', '试看集', '价格(USD)', '状态', '地区'], filteredRows.value.map((row) => [row.id, row.title, row.genres.join('/'), row.episodeCount, row.freeEpisodeCount, row.price, row.publishStatus, row.targetRegion]));
  ElMessage.success('短剧列表已导出');
};
</script>

<template>
  <div>
    <AdminPageHeader title="短剧管理" description="管理短剧资料、分集、素材、试看范围与发布状态。">
      <el-button :disabled="!mediaAvailable" @click="selectedRows.length ? openEpisodes(selectedRows[0]) : ElMessage.warning('请选择一部短剧')"><Upload :size="16" />上传分集</el-button>
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

    <section v-if="loading" class="admin-panel admin-data-state"><el-skeleton :rows="8" animated /></section>
    <section v-else-if="loadError" class="admin-panel admin-data-state"><span><CloudOff :size="28" /></span><h2>无法读取短剧数据</h2><p>管理接口未连接，或 D1 配置表未初始化。</p><el-button @click="loadSeries"><RefreshCw :size="16" />重试</el-button></section>
    <section v-else class="admin-panel admin-table-panel">
      <el-table :data="filteredRows" row-key="id" @selection-change="(rows: AdminSeries[]) => selectedRows = rows">
        <el-table-column type="selection" width="48" />
        <el-table-column label="短剧" min-width="270"><template #default="scope"><div class="series-cell"><img :src="scope.row.coverUrl" alt="" /><div><strong>{{ scope.row.title }}</strong><span>{{ scope.row.id }} · {{ scope.row.episodeCount }} 集 · {{ scope.row.targetRegion }}</span></div></div></template></el-table-column>
        <el-table-column label="分类" min-width="155"><template #default="scope"><el-tag v-for="genre in scope.row.genres.slice(0, 2)" :key="genre" size="small" effect="plain">{{ genre }}</el-tag></template></el-table-column>
        <el-table-column prop="freeEpisodeCount" label="试看集" width="82" />
        <el-table-column label="价格" width="86"><template #default="scope">${{ scope.row.price.toFixed(2) }}</template></el-table-column>
        <el-table-column label="状态" width="118"><template #default="scope"><div class="status-stack"><el-tag :type="tagType(scope.row.publishStatus) as any" effect="light">{{ scope.row.publishStatus }}</el-tag><small v-if="scope.row.publishStatus === '处理中'">{{ scope.row.transcodeProgress }}%</small></div></template></el-table-column>
        <el-table-column prop="publishAt" label="更新时间" width="112" />
        <el-table-column label="操作" fixed="right" width="176"><template #default="scope"><el-button link type="primary" @click="openEdit(scope.row)">编辑</el-button><el-button link @click="openEpisodes(scope.row)">分集</el-button><el-dropdown @command="(command: string) => command === 'copy' ? duplicate(scope.row) : command === 'delete' ? removeSeries(scope.row) : updateStatus([scope.row], command as PublishStatus)"><el-button link>更多</el-button><template #dropdown><el-dropdown-menu><el-dropdown-item command="已上架">上架</el-dropdown-item><el-dropdown-item command="已下架">下架</el-dropdown-item><el-dropdown-item command="copy" divided>复制短剧</el-dropdown-item><el-dropdown-item command="delete" divided>删除短剧</el-dropdown-item></el-dropdown-menu></template></el-dropdown></template></el-table-column>
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
      <template #footer><el-button @click="dialogVisible = false">取消</el-button><el-button type="primary" :loading="saving" @click="saveSeries">{{ editingId ? '保存修改' : '创建草稿' }}</el-button></template>
    </el-dialog>

    <el-drawer v-model="episodeDrawer" :title="`${selectedSeries?.title || ''} · 分集管理`" size="min(620px, 92vw)">
      <div v-if="selectedSeries" class="episode-manager">
        <el-alert v-if="episodeError" :title="episodeError" type="error" :closable="false" show-icon><el-button link type="primary" @click="loadEpisodes()">重试</el-button></el-alert>
        <section class="episode-upload-section">
          <el-alert v-if="!mediaAvailabilityLoading && !mediaAvailable" title="R2/Stream 媒体链路尚未配置，当前不能上传或转码；完成系统配置后刷新本页即可启用。" type="warning" :closable="false" show-icon />
          <div class="episode-section-heading"><div><strong>上传原片</strong><span>文件按选择顺序对应连续集号</span></div><el-input-number v-model="episodeStart" aria-label="起始集数" :min="1" :max="10000" :disabled="uploading || !mediaAvailable" controls-position="right" /></div>
          <div class="episode-upload-box">
            <Upload :size="26" />
            <div><strong>{{ selectedFiles.length ? `已选择 ${selectedFiles.length} 个文件` : '选择 MP4/MOV 原片' }}</strong><span>单文件最大 20 GB，支持中断后继续上传</span></div>
            <el-upload :auto-upload="false" :show-file-list="true" :multiple="true" :limit="50" accept="video/mp4,video/quicktime,.mp4,.mov" :disabled="uploading || !mediaAvailable" :on-change="onFileSelected" :on-remove="onFileSelected"><el-button :disabled="uploading || !mediaAvailable"><FileVideo :size="15" />选择视频</el-button></el-upload>
            <el-button type="primary" :loading="uploading" :disabled="!mediaAvailable || !selectedFiles.length" @click="startTranscode">{{ uploading ? '正在上传' : '上传并转码' }}</el-button>
          </div>
          <div v-if="uploading || uploadProgress" class="episode-upload-progress"><div><span>{{ uploadLabel || '上传完成' }}</span><strong>{{ uploadProgress }}%</strong></div><el-progress :percentage="uploadProgress" :show-text="false" :status="uploadProgress === 100 ? 'success' : undefined" /></div>
        </section>

        <section class="episode-list">
          <div class="episode-list__header"><strong>分集与媒体任务</strong><span>{{ episodes.length }} 集</span></div>
          <div v-if="episodesLoading" class="episode-list-state"><el-skeleton :rows="5" animated /></div>
          <div v-else-if="!episodes.length" class="episode-list-state"><Film :size="26" /><span>还没有分集，从上方上传第一集</span></div>
          <div v-for="episode in episodes" v-else :key="episode.id" class="episode-row">
            <span class="episode-index">{{ String(episode.episodeNo).padStart(2, '0') }}</span>
            <div><strong>{{ episode.title }}</strong><span>{{ episode.sourceFileName || '尚无媒体文件' }} · {{ formatBytes(episode.sourceSizeBytes) }}<template v-if="episode.durationSeconds"> · {{ formatDuration(episode.durationSeconds) }}</template></span><small v-if="episode.errorMessage">{{ episode.errorMessage }}</small></div>
            <el-tag :type="mediaStatus(episode)[1] as any" effect="light">{{ mediaStatus(episode)[0] }}</el-tag>
            <el-tooltip v-if="episode.previewUrl" content="发布前预览" placement="top"><el-button circle text aria-label="发布前预览" @click="openPreview(episode)"><Eye :size="16" /></el-button></el-tooltip>
            <el-tooltip v-if="episode.videoStatus === 'failed'" content="重试转码" placement="top"><el-button circle text aria-label="重试转码" @click="retryTranscode(episode)"><RefreshCw :size="16" /></el-button></el-tooltip>
          </div>
        </section>
      </div>
    </el-drawer>

    <el-dialog v-model="previewVisible" title="发布前预览" width="min(860px, 92vw)" destroy-on-close>
      <video ref="previewVideo" class="admin-video-preview" controls playsinline />
    </el-dialog>
  </div>
</template>
