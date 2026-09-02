<script setup lang="ts">
import { ArrowDown, ArrowUp, Eye, GripVertical, Plus, Settings2, Trash2 } from 'lucide-vue-next';
import { ElMessage, ElMessageBox } from 'element-plus';
import type { AdminSeries, HomeSectionConfig } from '~/composables/useAdminStore';

definePageMeta({ layout: 'admin', keepalive: true });

const { state, addAudit } = useAdminStore();
const adminApi = useAdminApi();
const syncing = ref(false);
const dialogVisible = ref(false);
const editingId = ref<string | null>(null);
const draggingId = ref<string | null>(null);
const form = reactive({ title: '', subtitle: '', source: '手动推荐 + 热度排序', count: 6, itemIds: [] as string[] });
const sections = computed(() => state.value.homeSections);
const previewSection = computed(() => sections.value.find((section) => section.enabled));
const previewItems = computed(() => previewSection.value?.itemIds.slice(0, previewSection.value.count).map((id) => state.value.series.find((item) => item.id === id)).filter((item): item is AdminSeries => Boolean(item)) || []);

onMounted(async () => {
  try {
    const [home, series] = await Promise.all([adminApi.getHomeConfig(), adminApi.getSeries()]);
    state.value.homeSections = home.items;
    state.value.series = series.items;
  } catch {
    ElMessage.error('首页配置与短剧数据加载失败');
  }
});

const persist = async () => {
  syncing.value = true;
  try {
    const response = await adminApi.saveHomeConfig(sections.value);
    state.value.homeSections = response.items;
    return true;
  } catch {
    ElMessage.error('首页配置发布失败，请稍后重试');
    return false;
  } finally {
    syncing.value = false;
  }
};

const openEditor = (section?: HomeSectionConfig) => {
  editingId.value = section?.id || null;
  Object.assign(form, section ? { title: section.title, subtitle: section.subtitle, source: section.source, count: section.count, itemIds: [...section.itemIds] } : { title: '', subtitle: '', source: '手动推荐 + 热度排序', count: 6, itemIds: [] });
  dialogVisible.value = true;
};

const saveSection = async () => {
  if (!form.title.trim() || (form.source === '手动推荐 + 热度排序' && !form.itemIds.length)) return ElMessage.warning('请填写标题，并为手动推荐分区至少选择一部短剧');
  const previous = sections.value.map((section) => ({ ...section, itemIds: [...section.itemIds] }));
  if (editingId.value) {
    const section = sections.value.find((item) => item.id === editingId.value);
    if (!section) return;
    Object.assign(section, { ...form, title: form.title.trim(), itemIds: [...form.itemIds] });
    addAudit({ module: '首页配置', action: '编辑首页分区', target: section.title, detail: `来源：${section.source}，展示 ${section.count} 部`, risk: '普通' });
  } else {
    const section: HomeSectionConfig = { id: `section-${Date.now()}`, title: form.title.trim(), subtitle: form.subtitle, source: form.source, count: form.count, itemIds: [...form.itemIds], enabled: false };
    state.value.homeSections.push(section);
    addAudit({ module: '首页配置', action: '新增首页分区', target: section.title, detail: '默认关闭，需确认后启用', risk: '普通' });
  }
  if (!await persist()) {
    state.value.homeSections = previous;
    return;
  }
  dialogVisible.value = false;
  ElMessage.success('分区配置已保存');
};

const move = (index: number, direction: -1 | 1) => {
  const next = index + direction;
  if (next < 0 || next >= sections.value.length) return;
  const list = state.value.homeSections;
  [list[index], list[next]] = [list[next], list[index]];
};

const drop = (targetId: string) => {
  const sourceId = draggingId.value;
  if (!sourceId || sourceId === targetId) return;
  const list = state.value.homeSections;
  const sourceIndex = list.findIndex((item) => item.id === sourceId);
  const targetIndex = list.findIndex((item) => item.id === targetId);
  const [item] = list.splice(sourceIndex, 1);
  list.splice(targetIndex, 0, item);
  draggingId.value = null;
};

const saveOrder = async () => {
  const previous = sections.value.map((section) => ({ ...section, itemIds: [...section.itemIds] }));
  if (!await persist()) {
    state.value.homeSections = previous;
    return;
  }
  addAudit({ module: '首页配置', action: '发布首页排序', target: 'H5 首页', detail: sections.value.map((item) => item.title).join(' → '), risk: '普通' });
  ElMessage.success('首页顺序已发布');
};

const toggleSection = async (section: HomeSectionConfig) => {
  if (!await persist()) {
    section.enabled = !section.enabled;
    return;
  }
  addAudit({ module: '首页配置', action: section.enabled ? '启用首页分区' : '隐藏首页分区', target: section.title, detail: `线上状态：${section.enabled ? '显示' : '隐藏'}`, risk: '普通' });
  ElMessage.success(section.enabled ? '分区已启用' : '分区已隐藏');
};

const removeSection = async (section: HomeSectionConfig) => {
  await ElMessageBox.confirm(`确定删除分区“${section.title}”吗？`, '删除分区', { type: 'warning' });
  const previous = sections.value.map((item) => ({ ...item, itemIds: [...item.itemIds] }));
  state.value.homeSections = sections.value.filter((item) => item.id !== section.id);
  if (!await persist()) {
    state.value.homeSections = previous;
    return;
  }
  addAudit({ module: '首页配置', action: '删除首页分区', target: section.title, detail: '分区配置已删除', risk: '普通' });
  ElMessage.success('分区已删除');
};

const openPreview = () => window.open('/', '_blank', 'noopener,noreferrer');
</script>

<template>
  <div>
    <AdminPageHeader title="首页配置" description="调整 H5 首页分区的顺序、内容来源、展示数量和启用状态。"><el-button @click="openPreview"><Eye :size="16" />打开 H5</el-button><el-button type="primary" @click="openEditor()"><Plus :size="16" />新增分区</el-button></AdminPageHeader>
    <div class="operations-layout">
      <section class="admin-panel section-config-list">
        <div class="admin-panel__header"><div><h2>首页内容分区</h2><p>拖动手柄或使用箭头调整线上顺序</p></div><el-button type="primary" :loading="syncing" @click="saveOrder">发布排序</el-button></div>
        <article v-for="(section, index) in sections" :key="section.id" class="config-row" draggable="true" @dragstart="draggingId = section.id" @dragover.prevent @drop="drop(section.id)">
          <GripVertical :size="20" class="drag-handle" />
          <span class="config-row__order">{{ String(index + 1).padStart(2, '0') }}</span>
          <div class="config-row__body"><strong>{{ section.title }}</strong><span>{{ section.subtitle }} · {{ section.source }}</span></div>
          <el-tag effect="plain">{{ section.count }} 部</el-tag>
          <div class="row-order-actions"><el-button text circle title="上移" :disabled="index === 0" @click="move(index, -1)"><ArrowUp :size="15" /></el-button><el-button text circle title="下移" :disabled="index === sections.length - 1" @click="move(index, 1)"><ArrowDown :size="15" /></el-button></div>
          <el-switch v-model="section.enabled" @change="toggleSection(section)" />
          <el-button circle title="编辑分区" @click="openEditor(section)"><Settings2 :size="16" /></el-button>
          <el-button text circle title="删除分区" @click="removeSection(section)"><Trash2 :size="16" /></el-button>
        </article>
      </section>
      <aside class="admin-panel h5-preview-panel">
        <div class="admin-panel__header"><div><h2>移动端预览</h2><p>启用后的首个分区 · 375 × 812</p></div><el-tag v-if="previewSection" type="success">实时</el-tag></div>
        <div class="phone-preview"><div class="phone-preview__header"><strong>REELNOVA</strong><i /></div><div class="phone-preview__tabs"><span class="active">Popular</span><span>New</span><span>Rankings</span></div><strong class="phone-preview__title">{{ previewSection?.title || '暂无启用分区' }}</strong><div class="phone-preview__grid"><div v-for="item in previewItems" :key="item.id"><img :src="item.coverUrl" alt="" /><span>{{ item.title }}</span></div></div><div class="phone-preview__nav"><span>●</span><span>◇</span><span>▢</span><span>○</span></div></div>
      </aside>
    </div>

    <el-dialog v-model="dialogVisible" :title="editingId ? '编辑首页分区' : '新增首页分区'" width="min(640px, 92vw)">
      <el-form label-position="top"><div class="form-grid"><el-form-item label="分区标题" required><el-input v-model="form.title" placeholder="例如 Popular now" /></el-form-item><el-form-item label="副标题"><el-input v-model="form.subtitle" placeholder="例如 Most watched this week" /></el-form-item></div><div class="form-grid"><el-form-item label="内容来源"><el-select v-model="form.source" style="width: 100%"><el-option label="手动推荐 + 热度排序" value="手动推荐 + 热度排序" /><el-option label="按更新时间自动排序" value="按更新时间自动排序" /><el-option label="按收入自动排序" value="按收入自动排序" /></el-select></el-form-item><el-form-item label="展示数量"><el-input-number v-model="form.count" :min="3" :max="12" /></el-form-item></div><el-form-item v-if="form.source === '手动推荐 + 热度排序'" label="选择短剧" required><el-select v-model="form.itemIds" multiple filterable style="width: 100%" placeholder="选择要展示的短剧"><el-option v-for="item in state.series" :key="item.id" :label="item.title" :value="item.id" /></el-select></el-form-item></el-form>
      <template #footer><el-button @click="dialogVisible = false">取消</el-button><el-button type="primary" @click="saveSection">保存分区</el-button></template>
    </el-dialog>
  </div>
</template>
