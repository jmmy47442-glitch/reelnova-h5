<script setup lang="ts">
import { CloudOff, Download, Eye, Film, FileVideo, GripVertical, Plus, RefreshCw, Search, Trash2, Upload, X } from 'lucide-vue-next';
import Hls from 'hls.js';
import { createFile as createMp4File } from 'mp4box';
import Sortable from 'sortablejs';
import { ElMessage, ElMessageBox, type UploadFile, type UploadFiles, type UploadInstance } from 'element-plus';
import type { AdminEpisode, MediaUploadPart, MediaUploadSession } from '~/types/admin';
import type { AdminSeries, PublishStatus } from '~/composables/useAdminStore';

definePageMeta({ layout: 'admin', keepalive: true });

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
const uploadControl = ref<UploadInstance>();
const episodeStart = ref(1);
const uploadProgress = ref(0);
const uploadLabel = ref('');
const uploadSpeed = ref(0);
const uploadUploadedBytes = ref(0);
const uploadTotalBytes = ref(0);
const uploadCancelled = ref(false);
const uploadFinalizing = ref(false);
const selectedUploadFiles = ref<UploadFile[]>([]);
const activeUploadSessionId = ref<string | null>(null);
const cancellingUploadIds = ref<string[]>([]);
let activeUploadResumeKey = '';
let activeUploadIdempotencyKey = '';
const activeUploadRequests = new Set<XMLHttpRequest>();
const uploadPartConcurrency = 3;
const mediaAvailable = ref(false);
const mediaAvailabilityLoading = ref(true);
const episodes = ref<AdminEpisode[]>([]);
const episodesLoading = ref(false);
const episodeError = ref('');
const deletingEpisodeIds = ref<string[]>([]);
const episodeListElement = ref<HTMLElement | null>(null);
const episodeOrderSaving = ref(false);
const episodeAccessSavingIds = ref<string[]>([]);
const episodeOrderAnnouncement = ref('');
const previewVisible = ref(false);
const previewVideo = ref<HTMLVideoElement | null>(null);
const previewEpisode = ref<AdminEpisode | null>(null);
let episodePoll: ReturnType<typeof setInterval> | undefined;
let previewHls: Hls | undefined;
let episodeSortable: Sortable | undefined;
let episodeLoadRequestId = 0;
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
  try { mediaAvailable.value = (await api.getConnection()).cloudflare.uploadConfigured; }
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
  selectedSeries.value = null;
  episodes.value = [];
  episodeError.value = '';
  Object.assign(form, { title: '', description: '', genres: [], targetRegion: 'United States', freeEpisodeCount: 3, price: 4.99 });
  dialogVisible.value = true;
};

const openEdit = (row: AdminSeries) => {
  editingId.value = row.id;
  selectedSeries.value = row;
  episodes.value = [];
  episodeError.value = '';
  Object.assign(form, { title: row.title, description: row.description, genres: [...row.genres], targetRegion: row.targetRegion, freeEpisodeCount: row.freeEpisodeCount, price: row.price });
  dialogVisible.value = true;
  void loadEpisodes();
};

const saveSeries = async () => {
  if (!form.title.trim() || !form.genres.length) {
    ElMessage.warning('请填写剧名并至少选择一个分类');
    return;
  }
  const current = editingId.value ? state.value.series.find((item) => item.id === editingId.value) : undefined;
  const freeEpisodeCount = editingId.value && !episodesLoading.value && !episodeError.value
    ? episodes.value.filter((episode) => episode.isFree).length
    : form.freeEpisodeCount;
  if (current && current.episodeCount > freeEpisodeCount && form.price <= 0) {
    ElMessage.warning('仍有付费分集时，解锁价格必须大于 0 美元');
    return;
  }
  saving.value = true;
  const input = { ...form, freeEpisodeCount, title: form.title.trim(), description: form.description.trim(), genres: [...form.genres] };
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
  if (next === '已上架' && rows.some((row) => row.episodeCount > row.freeEpisodeCount && row.price <= 0)) {
    return ElMessage.warning('存在零价但仍有锁定分集的短剧，请先设置解锁价格');
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
  if (value === null) return '—';
  if (value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / 1024 ** index).toFixed(index > 1 ? 1 : 0)} ${units[index]}`;
};
const formatUploadSpeed = (value: number) => {
  if (!value || !Number.isFinite(value)) return '测速中…';
  return `${formatBytes(value)}/s`;
};
const formatDuration = (value: number) => `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, '0')}`;
const mediaStatus = (episode: AdminEpisode) => episode.videoStatus === 'validating' && episode.errorMessage
  ? ['待恢复', 'danger'] as [string, string]
  : ({
  waiting_upload: ['待上传', 'info'], uploading: ['上传中', 'warning'], validating: ['校验中', 'warning'],
  processing: [`转码 ${episode.transcodeProgress}%`, 'warning'], ready: ['可发布', 'success'], failed: ['处理失败', 'danger'],
}[episode.videoStatus] || ['未知', 'info']) as [string, string];
const mediaErrorMessage = (message: string) => /Bad Request: The request was invalid/i.test(message)
  ? 'Stream 无法读取原片，请重试转码；如仍失败，请检查媒体 Worker。'
  : message;

const episodeRequestStatus = (reason: any) => Number(
  reason?.statusCode || reason?.status || reason?.response?.status || reason?.data?.statusCode || 0,
);
const episodeRequestMessage = (reason: any) => {
  const status = episodeRequestStatus(reason);
  if (!status) return '网络连接中断，暂时无法读取分集';
  if (status === 401 || status === 403) return '登录状态已失效，请重新登录后再试';
  if (status >= 500) return '分集服务暂时不可用，请稍后重试';
  return reason?.data?.statusMessage || reason?.data?.message || reason?.statusMessage || '无法读取分集和媒体任务';
};

const loadEpisodes = async (showLoading = true) => {
  const seriesId = selectedSeries.value?.id;
  if (!seriesId) return;
  const requestId = ++episodeLoadRequestId;
  if (showLoading) episodesLoading.value = true;
  episodeError.value = '';
  try {
    const loaded = (await api.getEpisodes(seriesId)).items;
    if (requestId !== episodeLoadRequestId || selectedSeries.value?.id !== seriesId) return;
    episodes.value = loaded;
    const row = state.value.series.find((item) => item.id === seriesId);
    if (row) {
      row.episodeCount = episodes.value.length;
      row.freeEpisodeCount = episodes.value.filter((episode) => episode.isFree).length;
      row.transcodeProgress = episodes.value.length
        ? Math.round(episodes.value.reduce((sum, episode) => sum + episode.transcodeProgress, 0) / episodes.value.length)
        : 0;
      selectedSeries.value = row;
      form.freeEpisodeCount = row.freeEpisodeCount;
    }
  } catch (reason: any) {
    if (requestId === episodeLoadRequestId && selectedSeries.value?.id === seriesId) {
      episodeError.value = episodeRequestMessage(reason);
    }
  } finally {
    if (requestId === episodeLoadRequestId && selectedSeries.value?.id === seriesId) episodesLoading.value = false;
  }
};

const syncEpisodeSummary = (markDraft = true) => {
  const seriesId = selectedSeries.value?.id;
  const row = state.value.series.find((item) => item.id === seriesId);
  if (!row) return;
  row.episodeCount = episodes.value.length;
  row.freeEpisodeCount = episodes.value.filter((episode) => episode.isFree).length;
  row.transcodeProgress = episodes.value.length
    ? Math.round(episodes.value.reduce((sum, episode) => sum + episode.transcodeProgress, 0) / episodes.value.length)
    : 0;
  if (markDraft) {
    if (row.publishStatus !== '版权冻结') row.publishStatus = '草稿';
    row.publishAt = new Date().toISOString().slice(0, 10);
  }
  selectedSeries.value = row;
  form.freeEpisodeCount = row.freeEpisodeCount;
};

const toggleEpisodeAccess = async (episode: AdminEpisode, isFree: boolean) => {
  const seriesId = selectedSeries.value?.id;
  if (!seriesId || episodeAccessSavingIds.value.includes(episode.id) || episode.isFree === isFree) return;
  const previous = episode.isFree;
  episode.isFree = isFree;
  // Access changes are live content settings and must not unpublish the series.
  syncEpisodeSummary(false);
  episodeAccessSavingIds.value = [...episodeAccessSavingIds.value, episode.id];
  try {
    const updated = await api.updateEpisodeAccess(seriesId, episode.id, isFree);
    const index = episodes.value.findIndex((item) => item.id === updated.id);
    if (index >= 0) episodes.value[index] = updated;
    syncEpisodeSummary(false);
    ElMessage.success(`第 ${updated.episodeNo} 集已设为${isFree ? '试看' : '收费'}`);
  } catch (reason: any) {
    episode.isFree = previous;
    syncEpisodeSummary(false);
    ElMessage.error(reason?.data?.statusMessage || '剧集试看设置保存失败');
  } finally {
    episodeAccessSavingIds.value = episodeAccessSavingIds.value.filter((id) => id !== episode.id);
  }
};

const clientOrderedEpisodes = (items: AdminEpisode[]) => items.map((episode, index) => {
  const episodeNo = index + 1;
  return {
    ...episode,
    episodeNo,
    title: episode.title === `Episode ${episode.episodeNo}` ? `Episode ${episodeNo}` : episode.title,
    isFree: episode.isFree,
  };
});

const persistEpisodeOrder = async (next: AdminEpisode[], previous: AdminEpisode[]) => {
  if (!editingId.value || episodeOrderSaving.value) return;
  episodeOrderSaving.value = true;
  episodes.value = clientOrderedEpisodes(next);
  episodeOrderAnnouncement.value = `正在保存，共 ${episodes.value.length} 集`;
  try {
    episodes.value = (await api.reorderEpisodes(editingId.value, episodes.value.map((episode) => episode.id))).items;
    syncEpisodeSummary();
    episodeOrderAnnouncement.value = '剧集顺序已保存';
    ElMessage.success('剧集顺序已保存，前台集数已同步更新');
  } catch (reason: any) {
    episodes.value = previous;
    episodeOrderAnnouncement.value = '排序保存失败，已恢复原顺序';
    ElMessage.error(reason?.data?.statusMessage || '剧集顺序保存失败');
  } finally {
    episodeOrderSaving.value = false;
  }
};

const moveEpisode = (episode: AdminEpisode, offset: -1 | 1) => {
  if (episodeOrderSaving.value || deletingEpisodeIds.value.length) return;
  const oldIndex = episodes.value.findIndex((item) => item.id === episode.id);
  const newIndex = oldIndex + offset;
  if (oldIndex < 0 || newIndex < 0 || newIndex >= episodes.value.length) return;
  const previous = [...episodes.value];
  const next = [...episodes.value];
  const [moved] = next.splice(oldIndex, 1);
  next.splice(newIndex, 0, moved!);
  void persistEpisodeOrder(next, previous);
};

const initializeEpisodeSorting = async () => {
  await nextTick();
  episodeSortable?.destroy();
  episodeSortable = undefined;
  if (!dialogVisible.value || !episodeListElement.value || episodes.value.length < 2) return;
  episodeSortable = Sortable.create(episodeListElement.value, {
    animation: 180,
    draggable: '.series-editor-episode-row',
    handle: '.episode-drag-handle',
    ghostClass: 'is-drag-ghost',
    chosenClass: 'is-drag-chosen',
    dragClass: 'is-dragging',
    forceFallback: true,
    fallbackTolerance: 4,
    disabled: episodeOrderSaving.value || deletingEpisodeIds.value.length > 0,
    onEnd: ({ oldIndex, newIndex }) => {
      if (oldIndex === undefined || newIndex === undefined || oldIndex === newIndex) return;
      const previous = [...episodes.value];
      const next = [...episodes.value];
      const [moved] = next.splice(oldIndex, 1);
      next.splice(newIndex, 0, moved!);
      void persistEpisodeOrder(next, previous);
    },
  });
};

const resequenceEpisodesForEditor = (items: AdminEpisode[]) => items
  .slice()
  .sort((left, right) => left.episodeNo - right.episodeNo)
  .map((item, index) => {
    const episodeNo = index + 1;
    return {
      ...item,
      episodeNo,
      title: /^Episode \d+$/i.test(item.title) ? `Episode ${episodeNo}` : item.title,
      isFree: item.isFree,
    };
  });

const removeEpisode = async (episode: AdminEpisode) => {
  if (!editingId.value || deletingEpisodeIds.value.includes(episode.id)) return;
  if (episode.videoStatus === 'uploading') {
    ElMessage.warning('请先在分集管理中取消该集正在进行的上传');
    return;
  }
  await ElMessageBox.confirm(
    `确定删除第 ${episode.episodeNo} 集“${episode.title}”吗？该集将从前台移除，关联媒体也会停止使用。`,
    '删除剧集',
    {
      type: 'warning',
      confirmButtonText: '确认删除',
      cancelButtonText: '取消',
      appendTo: 'body',
      customClass: 'series-editor-delete-confirm',
    },
  );
  const previousEpisodes = [...episodes.value];
  deletingEpisodeIds.value = [...deletingEpisodeIds.value, episode.id];
  episodes.value = resequenceEpisodesForEditor(episodes.value.filter((item) => item.id !== episode.id));
  syncEpisodeSummary();
  episodeOrderAnnouncement.value = `正在删除第 ${episode.episodeNo} 集`;
  try {
    const result = await api.deleteEpisode(editingId.value, episode.id);
    episodes.value = result.items;
    syncEpisodeSummary();
    episodeOrderAnnouncement.value = `第 ${episode.episodeNo} 集已删除，其余剧集已连续重排`;
    ElMessage.success(`第 ${episode.episodeNo} 集已删除，其余剧集已自动补位`);
  } catch (reason: any) {
    episodes.value = previousEpisodes;
    syncEpisodeSummary();
    ElMessage.error(reason?.data?.statusMessage || '删除剧集失败');
  } finally {
    deletingEpisodeIds.value = deletingEpisodeIds.value.filter((id) => id !== episode.id);
  }
};

const nextEpisodeNo = () => Math.max(0, ...episodes.value.map((episode) => episode.episodeNo)) + 1;

const openEpisodes = (row: AdminSeries, targetEpisodeNo?: number) => {
  selectedSeries.value = row;
  episodeStart.value = targetEpisodeNo || Math.max(1, row.episodeCount + 1);
  selectedFiles.value = [];
  selectedUploadFiles.value = [];
  uploadControl.value?.clearFiles();
  uploadProgress.value = 0;
  uploadSpeed.value = 0;
  uploadUploadedBytes.value = 0;
  uploadTotalBytes.value = 0;
  episodeDrawer.value = true;
  void loadEpisodes();
};

const openEpisodeUploader = (targetEpisodeNo?: number) => {
  if (!selectedSeries.value) return;
  openEpisodes(selectedSeries.value, targetEpisodeNo || nextEpisodeNo());
};

const onFileSelected = (_file: UploadFile, files: UploadFiles) => {
  if (!uploading.value) {
    uploadProgress.value = 0;
    uploadLabel.value = '';
    uploadSpeed.value = 0;
    uploadUploadedBytes.value = 0;
    uploadTotalBytes.value = 0;
  }
  selectedUploadFiles.value = [...files];
  selectedFiles.value = selectedUploadFiles.value.reduce<File[]>((result, item) => {
    if (item.raw) result.push(item.raw);
    return result;
  }, []);
};

const removeSelectedFile = (file: UploadFile) => uploadControl.value?.handleRemove(file);
const selectedUploadAssignments = computed(() => selectedUploadFiles.value.map((file, index) => {
  const episodeNo = episodeStart.value + index;
  const existingEpisode = episodes.value.find((episode) => episode.episodeNo === episodeNo);
  return { file, episodeNo, existingEpisode };
}));
const blockedUploadAssignment = computed(() => selectedUploadAssignments.value.find(({ existingEpisode }) =>
  existingEpisode && ['uploading', 'validating', 'processing'].includes(existingEpisode.videoStatus)));

interface ResumeState { session: MediaUploadSession; parts: MediaUploadPart[] }
interface MediaProbe { durationSeconds: number; width: number; height: number; hasVideo: true; hasAudio: true }
const resumeKey = (seriesId: string, episodeNo: number, file: File) => `reelnova-upload:${seriesId}:${episodeNo}:${file.name}:${file.size}:${file.lastModified}`;
const readResume = (key: string) => {
  try {
    const value = JSON.parse(localStorage.getItem(key) || '') as ResumeState;
    if (value.session?.id && Date.parse(value.session.expiresAt) > Date.now()) return value;
    localStorage.removeItem(key);
    return null;
  } catch {
    localStorage.removeItem(key);
    return null;
  }
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
  activeUploadRequests.add(request);
  request.open('PUT', url);
  request.setRequestHeader('Authorization', `Bearer ${token}`);
  request.setRequestHeader('Content-Type', 'application/octet-stream');
  request.upload.onprogress = (event) => onProgress(event.loaded);
  request.onerror = () => reject(new Error('分片网络请求失败'));
  request.onabort = () => reject(new DOMException('上传已取消', 'AbortError'));
  request.onloadend = () => { activeUploadRequests.delete(request); };
  request.onload = () => {
    if (request.status < 200 || request.status >= 300) return reject(new Error(`分片上传失败 (${request.status})`));
    try { resolve(JSON.parse(request.responseText) as MediaUploadPart); }
    catch { reject(new Error('媒体 Worker 返回了无效响应')); }
  };
  request.send(blob);
});

const cancelUpload = () => {
  if (!uploading.value || uploadCancelled.value || uploadFinalizing.value) return;
  uploadCancelled.value = true;
  uploadLabel.value = '正在取消上传…';
  uploadSpeed.value = 0;
  if (activeUploadSessionId.value && !cancellingUploadIds.value.includes(activeUploadSessionId.value)) {
    cancellingUploadIds.value = [...cancellingUploadIds.value, activeUploadSessionId.value];
  }
  for (const request of activeUploadRequests) request.abort();
};

const clearUploadResumeState = (uploadId: string) => {
  for (let index = localStorage.length - 1; index >= 0; index -= 1) {
    const key = localStorage.key(index);
    if (!key?.startsWith('reelnova-upload:') || key.endsWith(':idempotency')) continue;
    try {
      const value = JSON.parse(localStorage.getItem(key) || '') as ResumeState;
      if (value.session?.id !== uploadId) continue;
      localStorage.removeItem(key);
      localStorage.removeItem(`${key}:idempotency`);
    } catch { /* Invalid resume state is cleared by readResume. */ }
  }
};

const cancelEpisode = async (episode: AdminEpisode) => {
  if (!episode.uploadId || cancellingUploadIds.value.includes(episode.uploadId)) return;
  if (episode.uploadId === activeUploadSessionId.value && uploading.value) {
    cancelUpload();
    return;
  }
  cancellingUploadIds.value = [...cancellingUploadIds.value, episode.uploadId];
  try {
    const result = await api.cancelEpisodeUpload(episode.uploadId);
    clearUploadResumeState(episode.uploadId);
    ElMessage.success(result.cleanupPending ? '上传已取消，R2 分片将在后台清理' : '上传已取消');
    await Promise.all([loadEpisodes(false), loadSeries()]);
  } catch (reason: any) {
    ElMessage.error(reason?.data?.statusMessage || '取消上传失败');
  } finally {
    cancellingUploadIds.value = cancellingUploadIds.value.filter((id) => id !== episode.uploadId);
  }
};

const uploadOne = async (file: File, episodeNo: number, completedBefore: number, totalBytes: number) => {
  if (!selectedSeries.value) return;
  const key = resumeKey(selectedSeries.value.id, episodeNo, file);
  const idempotencyStorageKey = `${key}:idempotency`;
  activeUploadResumeKey = key;
  activeUploadIdempotencyKey = idempotencyStorageKey;
  let resume = readResume(key);
  if (!resume) {
    uploadLabel.value = `正在校验 Episode ${episodeNo} · ${file.name}`;
    const probe = await inspectMedia(file);
    if (uploadCancelled.value) throw new DOMException('上传已取消', 'AbortError');
    const createSession = (idempotencyKey: string) => api.createEpisodeUpload(selectedSeries.value!.id, {
      idempotencyKey,
      episodeNo, title: `Episode ${episodeNo}`, fileName: file.name,
      contentType: file.type || (file.name.toLowerCase().endsWith('.mov') ? 'video/quicktime' : 'video/mp4'), fileSizeBytes: file.size,
      ...probe,
    });
    let idempotencyKey = localStorage.getItem(idempotencyStorageKey) || `upload:${crypto.randomUUID()}`;
    localStorage.setItem(idempotencyStorageKey, idempotencyKey);
    let session: MediaUploadSession;
    try {
      session = await createSession(idempotencyKey);
    } catch (error: any) {
      // An expired/aborted server session cannot be resumed. Rotate the local
      // key so a retry creates a fresh episode upload instead of a permanent 409.
      const statusMessage = String(error?.data?.statusMessage || error?.statusMessage || '');
      if (!/no longer active|not found|expired|aborted/i.test(statusMessage)) throw error;
      idempotencyKey = `upload:${crypto.randomUUID()}`;
      localStorage.setItem(idempotencyStorageKey, idempotencyKey);
      session = await createSession(idempotencyKey);
    }
    resume = { session, parts: [] };
    writeResume(key, resume);
  }
  const { session } = resume;
  activeUploadSessionId.value = session.id;
  if (uploadCancelled.value) throw new DOMException('上传已取消', 'AbortError');
  const parts = new Map(resume.parts.map((part) => [part.partNumber, part]));
  const partCount = Math.ceil(file.size / session.partSizeBytes);
  let completedBytes = [...parts.keys()].reduce((sum, partNumber) => sum + Math.min(session.partSizeBytes, file.size - (partNumber - 1) * session.partSizeBytes), 0);
  uploadUploadedBytes.value = completedBefore + completedBytes;
  let speedSampleBytes = uploadUploadedBytes.value;
  let speedSampleTime = performance.now();
  const pendingPartNumbers = Array.from({ length: partCount }, (_, index) => index + 1).filter((partNumber) => !parts.has(partNumber));
  const inFlightBytes = new Map<number, number>();
  let nextPendingIndex = 0;
  let firstUploadError: unknown;
  const updateUploadProgress = () => {
    const uploadedBytes = completedBefore + completedBytes + [...inFlightBytes.values()].reduce((sum, loaded) => sum + loaded, 0);
    const now = performance.now();
    const elapsed = now - speedSampleTime;
    if (elapsed >= 250 && uploadedBytes >= speedSampleBytes) {
      const instantSpeed = (uploadedBytes - speedSampleBytes) / (elapsed / 1000);
      uploadSpeed.value = uploadSpeed.value ? uploadSpeed.value * 0.7 + instantSpeed * 0.3 : instantSpeed;
      speedSampleBytes = uploadedBytes;
      speedSampleTime = now;
    }
    uploadUploadedBytes.value = uploadedBytes;
    uploadProgress.value = Math.min(99, Math.round(uploadedBytes / totalBytes * 100));
  };
  const uploadPendingPart = async (partNumber: number) => {
    const start = (partNumber - 1) * session.partSizeBytes;
    const blob = file.slice(start, Math.min(file.size, start + session.partSizeBytes));
    let uploaded: MediaUploadPart | undefined;
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3 && !uploaded; attempt += 1) {
      if (uploadCancelled.value) throw new DOMException('上传已取消', 'AbortError');
      inFlightBytes.set(partNumber, 0);
      try {
        uploaded = await uploadPart(`${session.uploadUrl}/parts/${partNumber}`, session.uploadToken, blob, (loaded) => {
          inFlightBytes.set(partNumber, Math.min(blob.size, loaded));
          updateUploadProgress();
        });
      } catch (error) {
        inFlightBytes.delete(partNumber);
        updateUploadProgress();
        if (uploadCancelled.value || (error instanceof DOMException && error.name === 'AbortError')) throw error;
        lastError = error;
      }
    }
    if (!uploaded) throw lastError || new Error('分片上传失败');
    inFlightBytes.delete(partNumber);
    parts.set(partNumber, uploaded);
    completedBytes += blob.size;
    updateUploadProgress();
    resume.parts = [...parts.values()].sort((left, right) => left.partNumber - right.partNumber);
    writeResume(key, resume);
    void api.reportUploadProgress(session.id, completedBytes).catch(() => undefined);
  };
  const uploadWorker = async () => {
    while (!firstUploadError && nextPendingIndex < pendingPartNumbers.length) {
      if (uploadCancelled.value) throw new DOMException('上传已取消', 'AbortError');
      const partNumber = pendingPartNumbers[nextPendingIndex++];
      try { await uploadPendingPart(partNumber); }
      catch (error) { firstUploadError ||= error; }
    }
  };
  const workerCount = Math.min(uploadPartConcurrency, pendingPartNumbers.length);
  await Promise.all(Array.from({ length: workerCount }, () => uploadWorker()));
  if (firstUploadError) throw firstUploadError;
  if (uploadCancelled.value) throw new DOMException('上传已取消', 'AbortError');
  uploadFinalizing.value = true;
  uploadLabel.value = `正在提交 Episode ${episodeNo} · ${file.name}`;
  const completion = await api.completeEpisodeUpload(session.id, [...parts.values()]);
  uploadFinalizing.value = false;
  if (completion.status === 'completing') {
    const detail = completion.errorMessage ? `：${mediaErrorMessage(completion.errorMessage)}` : '';
    throw new Error(`原片已保存到 R2，Stream 转码暂未提交${detail}`);
  }
  localStorage.removeItem(key);
  localStorage.removeItem(idempotencyStorageKey);
  activeUploadSessionId.value = null;
  activeUploadResumeKey = '';
  activeUploadIdempotencyKey = '';
};

const startTranscode = async () => {
  if (!selectedSeries.value) return;
  if (episodeError.value) return ElMessage.warning('请先重新加载分集，再选择要新增或替换的视频');
  if (!mediaAvailable.value) return ElMessage.warning('R2/Stream 媒体链路尚未配置');
  if (!selectedFiles.value.length) return ElMessage.warning('请选择一个或多个 MP4/MOV 文件');
  if (blockedUploadAssignment.value) return ElMessage.warning(`第 ${blockedUploadAssignment.value.episodeNo} 集正在处理媒体任务，请完成后再替换视频`);
  const invalid = selectedFiles.value.find((file) => !/\.(mp4|mov)$/i.test(file.name) || file.size < 1024 || file.size > 20 * 1024 ** 3);
  if (invalid) return ElMessage.error(`${invalid.name} 不是有效的 MP4/MOV 文件，或文件超过 20 GB`);
  uploading.value = true;
  uploadCancelled.value = false;
  uploadFinalizing.value = false;
  uploadProgress.value = 0;
  uploadSpeed.value = 0;
  uploadUploadedBytes.value = 0;
  const totalBytes = selectedFiles.value.reduce((sum, file) => sum + file.size, 0);
  uploadTotalBytes.value = totalBytes;
  let completedBefore = 0;
  try {
    for (let index = 0; index < selectedFiles.value.length; index += 1) {
      const file = selectedFiles.value[index];
      uploadLabel.value = `Episode ${episodeStart.value + index} · ${file.name}`;
      await uploadOne(file, episodeStart.value + index, completedBefore, totalBytes);
      completedBefore += file.size;
    }
    uploadProgress.value = 100;
    uploadUploadedBytes.value = totalBytes;
    uploadLabel.value = '上传完成';
    selectedFiles.value = [];
    selectedUploadFiles.value = [];
    uploadControl.value?.clearFiles();
    ElMessage.success('原片已写入 R2，Stream 转码任务已提交');
    await Promise.all([loadEpisodes(), loadSeries()]);
  } catch (reason) {
    if (uploadCancelled.value || (reason instanceof DOMException && reason.name === 'AbortError')) {
      uploadSpeed.value = 0;
      const sessionId = activeUploadSessionId.value;
      try {
        const result = sessionId ? await api.cancelEpisodeUpload(sessionId) : null;
        if (sessionId) clearUploadResumeState(sessionId);
        if (activeUploadResumeKey) localStorage.removeItem(activeUploadResumeKey);
        if (activeUploadIdempotencyKey) localStorage.removeItem(activeUploadIdempotencyKey);
        uploadLabel.value = '上传已取消';
        ElMessage.success(result?.cleanupPending ? '上传已取消，R2 分片将在后台清理' : '上传已取消');
      } catch (cancelError: any) {
        uploadLabel.value = '已停止上传，可稍后重试';
        ElMessage.warning(cancelError?.data?.statusMessage || '已停止本次上传，但服务端会话取消失败');
      }
      await Promise.all([loadEpisodes(false), loadSeries()]);
      return;
    }
    const message = reason instanceof Error ? reason.message : '上传中断';
    if (message.includes('原片已保存到 R2')) ElMessage.warning(`${message}，可重新点击上传或在分集列表重试。`);
    else ElMessage.error(`${message}，重新点击可从已完成分片继续`);
    await loadEpisodes(false);
  } finally {
    if (activeUploadSessionId.value) {
      cancellingUploadIds.value = cancellingUploadIds.value.filter((id) => id !== activeUploadSessionId.value);
    }
    activeUploadRequests.clear();
    activeUploadSessionId.value = null;
    activeUploadResumeKey = '';
    activeUploadIdempotencyKey = '';
    uploadFinalizing.value = false;
    uploading.value = false;
  }
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
  previewEpisode.value = episode;
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
watch([dialogVisible, episodesLoading, () => episodes.value.length], () => { void initializeEpisodeSorting(); }, { flush: 'post' });
watch([episodeOrderSaving, () => deletingEpisodeIds.value.length], ([savingOrder, deletingCount]) => {
  episodeSortable?.option('disabled', Boolean(savingOrder || deletingCount));
});
watch(previewVisible, (open) => {
  if (!open) {
    previewVideo.value?.pause();
    previewVideo.value?.removeAttribute('src');
    previewVideo.value?.load();
    previewHls?.destroy();
    previewHls = undefined;
    previewEpisode.value = null;
  }
});
onBeforeUnmount(() => {
  if (episodePoll) clearInterval(episodePoll);
  episodeSortable?.destroy();
  previewHls?.destroy();
  for (const request of activeUploadRequests) request.abort();
});

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
        <el-table-column label="操作" fixed="right" width="176"><template #default="scope"><div class="series-row-actions"><el-button link type="primary" @click="openEdit(scope.row)">编辑</el-button><el-button link @click="openEpisodes(scope.row)">分集</el-button><el-dropdown @command="(command: string) => command === 'copy' ? duplicate(scope.row) : command === 'delete' ? removeSeries(scope.row) : updateStatus([scope.row], command as PublishStatus)"><el-button link>更多</el-button><template #dropdown><el-dropdown-menu><el-dropdown-item command="已上架">上架</el-dropdown-item><el-dropdown-item command="已下架">下架</el-dropdown-item><el-dropdown-item command="copy" divided>复制短剧</el-dropdown-item><el-dropdown-item command="delete" divided>删除短剧</el-dropdown-item></el-dropdown-menu></template></el-dropdown></div></template></el-table-column>
        <template #empty><div class="table-empty"><Film :size="28" /><span>没有符合条件的短剧</span><el-button link type="primary" @click="resetFilters">清除筛选</el-button></div></template>
      </el-table>
      <div class="admin-pagination"><span>共 {{ filteredRows.length }} 条</span><el-pagination background layout="prev, pager, next" :total="filteredRows.length" :page-size="10" /></div>
    </section>

    <el-dialog v-model="dialogVisible" :title="editingId ? '编辑短剧' : '新建短剧'" width="min(760px, 94vw)" class="series-editor-dialog">
      <el-form label-position="top">
        <el-form-item label="英文剧名" required><el-input v-model="form.title" maxlength="80" show-word-limit placeholder="例如 Vows & Vengeance" /></el-form-item>
        <div class="form-grid"><el-form-item label="分类" required><el-select v-model="form.genres" multiple style="width: 100%" placeholder="选择分类"><el-option v-for="item in categories" :key="item" :label="item" :value="item" /></el-select></el-form-item><el-form-item label="目标地区"><el-select v-model="form.targetRegion" style="width: 100%"><el-option label="United States" value="United States" /><el-option label="Global" value="Global" /><el-option label="Canada" value="Canada" /></el-select></el-form-item></div>
        <div class="form-grid"><el-form-item label="试看集数（统计）"><el-input-number v-model="form.freeEpisodeCount" :min="0" :max="10000" :disabled="Boolean(editingId)" /><small v-if="editingId" class="series-editor-form-hint">请在下方逐集设置试看或收费</small></el-form-item><el-form-item label="解锁价格（USD）"><el-input-number v-model="form.price" :min="0" :precision="2" :step="1" /></el-form-item></div>
        <el-form-item label="短剧简介"><el-input v-model="form.description" type="textarea" :rows="4" maxlength="500" show-word-limit /></el-form-item>
      </el-form>
      <section v-if="editingId" class="series-editor-episodes" aria-labelledby="series-editor-episodes-title">
        <div class="series-editor-episodes__heading">
          <div><strong id="series-editor-episodes-title">对应剧集</strong><span>共 {{ episodes.length }} 集</span></div>
          <el-tag effect="plain" type="info">列表顺序即集数</el-tag>
        </div>
        <div class="series-editor-episode-add">
          <div><strong>新增剧集需同时上传视频</strong><span>可选择新集号，也可替换已有剧集的视频。</span></div>
          <el-button type="primary" :disabled="episodesLoading || Boolean(episodeError)" @click="openEpisodeUploader()"><Upload :size="16" />新增并上传</el-button>
        </div>
        <div v-if="episodesLoading" class="series-editor-episode-state"><el-skeleton :rows="3" animated /></div>
        <div v-else-if="episodeError" class="series-editor-episode-state series-editor-episode-state--error" role="alert"><CloudOff :size="24" /><strong>{{ episodeError }}</strong><span>分集未加载，新增和排序操作已暂停。</span><el-button type="primary" plain @click="loadEpisodes()"><RefreshCw :size="15" />重新加载</el-button></div>
        <div v-else-if="!episodes.length" class="series-editor-episode-state"><Film :size="24" /><strong>暂无剧集</strong><span>点击“新增并上传”，选择集数和对应视频</span></div>
        <div v-else ref="episodeListElement" class="series-editor-episode-list" :class="{ 'is-order-saving': episodeOrderSaving }">
          <article v-for="episode in episodes" :key="episode.id" class="series-editor-episode-row">
            <el-tooltip content="拖动排序；也可用上下方向键移动" placement="top">
              <button class="episode-drag-handle" type="button" :disabled="episodeOrderSaving || deletingEpisodeIds.length > 0" :aria-label="`调整第 ${episode.episodeNo} 集顺序，使用上下方向键移动`" @keydown.up.prevent="moveEpisode(episode, -1)" @keydown.down.prevent="moveEpisode(episode, 1)"><GripVertical :size="17" /></button>
            </el-tooltip>
            <span class="episode-index">{{ String(episode.episodeNo).padStart(2, '0') }}</span>
            <div class="series-editor-episode-row__content">
              <strong>{{ episode.title }}</strong>
              <span>{{ episode.sourceFileName || '未上传视频' }}<template v-if="episode.durationSeconds"> · {{ formatDuration(episode.durationSeconds) }}</template></span>
            </div>
            <el-tag size="small" effect="plain" :type="episode.isFree ? 'success' : 'danger'">{{ episode.isFree ? '试看' : '收费' }}</el-tag>
            <el-switch :model-value="episode.isFree" inline-prompt active-text="试看" inactive-text="收费" :loading="episodeAccessSavingIds.includes(episode.id)" :disabled="episodeOrderSaving || deletingEpisodeIds.length > 0" :aria-label="`设置第 ${episode.episodeNo} 集为${episode.isFree ? '收费' : '试看'}`" @change="(value) => toggleEpisodeAccess(episode, Boolean(value))" />
            <el-tag size="small" :type="mediaStatus(episode)[1] as any" effect="light">{{ mediaStatus(episode)[0] }}</el-tag>
            <el-tooltip :content="episode.previewUrl ? `预览第 ${episode.episodeNo} 集视频` : '视频就绪后可预览'" placement="top">
              <span><el-button class="series-editor-episode-preview" circle text :disabled="!episode.previewUrl" :aria-label="`预览第 ${episode.episodeNo} 集视频`" @click="openPreview(episode)"><Eye :size="16" /></el-button></span>
            </el-tooltip>
            <el-tooltip :content="episode.sourceFileName ? '替换该集视频' : '上传该集视频'" placement="top">
              <el-button class="series-editor-episode-upload" circle text type="primary" :disabled="['uploading', 'validating', 'processing'].includes(episode.videoStatus)" :aria-label="`${episode.sourceFileName ? '替换' : '上传'}第 ${episode.episodeNo} 集视频`" @click="openEpisodeUploader(episode.episodeNo)"><Upload :size="16" /></el-button>
            </el-tooltip>
            <el-tooltip :content="episode.videoStatus === 'uploading' ? '请先取消正在进行的上传' : '删除剧集'" placement="top">
              <el-button class="series-editor-episode-delete" circle text type="danger" :loading="deletingEpisodeIds.includes(episode.id)" :disabled="episode.videoStatus === 'uploading' || deletingEpisodeIds.includes(episode.id)" :aria-label="`删除第 ${episode.episodeNo} 集`" @click="removeEpisode(episode)"><Trash2 :size="16" /></el-button>
            </el-tooltip>
          </article>
        </div>
        <span class="sr-only" aria-live="polite">{{ episodeOrderAnnouncement }}</span>
      </section>
      <template #footer><el-button :disabled="episodeOrderSaving || deletingEpisodeIds.length > 0 || episodeAccessSavingIds.length > 0" @click="dialogVisible = false">取消</el-button><el-button type="primary" :loading="saving" :disabled="episodeOrderSaving || deletingEpisodeIds.length > 0 || episodeAccessSavingIds.length > 0" @click="saveSeries">{{ editingId ? '保存修改' : '创建草稿' }}</el-button></template>
    </el-dialog>

    <el-drawer v-model="episodeDrawer" class="admin-episode-drawer" :title="`${selectedSeries?.title || ''} · 分集管理`" size="min(620px, 92vw)" append-to-body>
      <div v-if="selectedSeries" class="episode-manager">
        <section class="episode-upload-section">
          <el-alert v-if="!mediaAvailabilityLoading && !mediaAvailable" title="R2/Stream 上传链路不可用，请在站点与支付中检查 D1、Media Worker 和 Stream API。" type="warning" :closable="false" show-icon />
          <div class="episode-section-heading">
            <div><strong>上传原片</strong><span>文件按选择顺序对应连续集号</span></div>
            <label class="episode-upload-target" for="episode-upload-start"><span>起始集数</span><el-input-number id="episode-upload-start" v-model="episodeStart" aria-label="起始集数" :min="1" :max="10000" :disabled="uploading || !mediaAvailable || Boolean(episodeError)" controls-position="right" /></label>
          </div>
          <div class="episode-upload-box">
            <Upload :size="26" />
            <div><strong>{{ selectedFiles.length ? `已选择 ${selectedFiles.length} 个文件` : '选择 MP4/MOV 原片' }}</strong><span>单文件最大 20 GB，支持中断后继续上传</span></div>
            <el-upload ref="uploadControl" :auto-upload="false" :show-file-list="false" :multiple="true" :limit="50" accept="video/mp4,video/quicktime,.mp4,.mov" :disabled="uploading || !mediaAvailable || Boolean(episodeError)" :on-change="onFileSelected" :on-remove="onFileSelected"><el-button :disabled="uploading || !mediaAvailable || Boolean(episodeError)"><FileVideo :size="15" />选择视频</el-button></el-upload>
            <el-button type="primary" :loading="uploading" :disabled="!mediaAvailable || Boolean(episodeError) || !selectedFiles.length || Boolean(blockedUploadAssignment)" @click="startTranscode">{{ uploading ? '正在上传' : '上传并转码' }}</el-button>
          </div>
          <div v-if="selectedUploadAssignments.length" class="episode-upload-assignments" aria-label="视频与剧集对应关系">
            <div v-for="assignment in selectedUploadAssignments" :key="assignment.file.uid" class="episode-upload-assignment">
              <span class="episode-index">{{ String(assignment.episodeNo).padStart(2, '0') }}</span>
              <div><strong>第 {{ assignment.episodeNo }} 集</strong><span>{{ assignment.file.name }} · {{ formatBytes(assignment.file.size || null) }}</span></div>
              <el-tag size="small" :type="assignment.existingEpisode && ['uploading', 'validating', 'processing'].includes(assignment.existingEpisode.videoStatus) ? 'danger' : assignment.existingEpisode ? 'warning' : 'success'" effect="plain">{{ assignment.existingEpisode && ['uploading', 'validating', 'processing'].includes(assignment.existingEpisode.videoStatus) ? '任务进行中' : assignment.existingEpisode ? '替换视频' : '新剧集' }}</el-tag>
              <el-tooltip content="移除此文件" placement="top"><el-button circle text :disabled="uploading" :aria-label="`移除 ${assignment.file.name}`" @click="removeSelectedFile(assignment.file)"><X :size="15" /></el-button></el-tooltip>
            </div>
          </div>
          <div v-if="uploading || uploadProgress" class="episode-upload-progress">
            <div class="episode-upload-progress__heading" aria-live="polite"><span>{{ uploadLabel || '上传完成' }}</span><div><strong>{{ uploadProgress }}%</strong><el-button v-if="uploading && !uploadFinalizing" text type="danger" size="small" :disabled="uploadCancelled" :aria-label="uploadCancelled ? '正在取消上传' : '取消当前视频上传'" @click="cancelUpload"><X :size="14" />{{ uploadCancelled ? '取消中' : '取消上传' }}</el-button></div></div>
            <el-progress :percentage="uploadProgress" :show-text="false" :status="uploadProgress === 100 ? 'success' : undefined" />
            <div class="episode-upload-progress__stats"><span>{{ formatBytes(uploadUploadedBytes) }} / {{ formatBytes(uploadTotalBytes) }}</span><strong>{{ formatUploadSpeed(uploadSpeed) }}</strong></div>
          </div>
        </section>

        <section class="episode-list">
          <div class="episode-list__header"><strong>分集与媒体任务</strong><span>{{ episodes.length }} 集</span></div>
          <div v-if="episodesLoading" class="episode-list-state"><el-skeleton :rows="5" animated /></div>
          <div v-else-if="episodeError" class="episode-list-state episode-list-state--error" role="alert"><CloudOff :size="26" /><strong>{{ episodeError }}</strong><span>为避免覆盖已有视频，上传操作已暂停。</span><el-button type="primary" plain @click="loadEpisodes()"><RefreshCw :size="15" />重新加载</el-button></div>
          <div v-else-if="!episodes.length" class="episode-list-state"><Film :size="26" /><span>还没有分集，从上方上传第一集</span></div>
          <div v-for="episode in episodes" v-else :key="episode.id" class="episode-row">
            <span class="episode-index">{{ String(episode.episodeNo).padStart(2, '0') }}</span>
            <div><strong>{{ episode.title }}</strong><span>{{ episode.sourceFileName || '尚无媒体文件' }} · {{ formatBytes(episode.sourceSizeBytes) }}<template v-if="episode.durationSeconds"> · {{ formatDuration(episode.durationSeconds) }}</template></span><small v-if="episode.errorMessage" role="alert">{{ mediaErrorMessage(episode.errorMessage) }}</small></div>
            <el-button v-if="episode.videoStatus === 'uploading' && episode.uploadId && !(uploadFinalizing && episode.uploadId === activeUploadSessionId)" class="episode-cancel-upload" text type="danger" size="small" :loading="cancellingUploadIds.includes(episode.uploadId)" :disabled="cancellingUploadIds.includes(episode.uploadId)" aria-label="取消该视频上传" @click="cancelEpisode(episode)"><X :size="14" />{{ cancellingUploadIds.includes(episode.uploadId) ? '取消中' : '取消' }}</el-button>
            <el-switch :model-value="episode.isFree" inline-prompt active-text="试看" inactive-text="收费" :loading="episodeAccessSavingIds.includes(episode.id)" :aria-label="`设置第 ${episode.episodeNo} 集为${episode.isFree ? '收费' : '试看'}`" @change="(value) => toggleEpisodeAccess(episode, Boolean(value))" />
            <el-tag :type="mediaStatus(episode)[1] as any" effect="light">{{ mediaStatus(episode)[0] }}</el-tag>
            <el-tooltip v-if="episode.previewUrl" content="发布前预览" placement="top"><el-button circle text aria-label="发布前预览" @click="openPreview(episode)"><Eye :size="16" /></el-button></el-tooltip>
            <el-tooltip v-if="episode.videoStatus === 'failed' || (episode.videoStatus === 'validating' && episode.errorMessage)" content="重试转码" placement="top"><el-button circle text aria-label="重试转码" @click="retryTranscode(episode)"><RefreshCw :size="16" /></el-button></el-tooltip>
          </div>
        </section>
      </div>
    </el-drawer>

    <el-dialog v-model="previewVisible" :title="previewEpisode ? `第 ${previewEpisode.episodeNo} 集 · ${previewEpisode.sourceFileName || previewEpisode.title}` : '视频预览'" width="min(860px, 92vw)" destroy-on-close>
      <video ref="previewVideo" class="admin-video-preview" controls playsinline />
    </el-dialog>
  </div>
</template>
