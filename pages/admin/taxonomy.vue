<script setup lang="ts">
import { Palette, Plus, Search, Trash2 } from 'lucide-vue-next';
import { ElMessage, ElMessageBox } from 'element-plus';
import type { TaxonomyItem } from '~/composables/useAdminStore';

definePageMeta({ layout: 'admin' });

const { state } = useAdminStore();
const api = useAdminApi();
const activeType = ref<'分类' | '标签'>('分类');
const keyword = ref('');
const dialogVisible = ref(false);
const editingId = ref<string | null>(null);
const loading = ref(true);
const saving = ref(false);
const form = reactive({ name: '', localeName: '', color: '#5d6bff', expiresAt: '', enabled: true });
const rows = computed(() => state.value.taxonomy.filter((item) => item.type === activeType.value && (!keyword.value || `${item.name} ${item.localeName}`.toLowerCase().includes(keyword.value.toLowerCase()))));

onMounted(async () => {
  try {
    state.value.taxonomy = (await api.getTaxonomy()).items;
  } catch {
    ElMessage.error('分类与标签加载失败');
  } finally {
    loading.value = false;
  }
});

const openEditor = (item?: TaxonomyItem) => {
  editingId.value = item?.id || null;
  Object.assign(form, item ? { name: item.name, localeName: item.localeName, color: item.color, expiresAt: item.expiresAt === '—' ? '' : item.expiresAt, enabled: item.enabled } : { name: '', localeName: '', color: activeType.value === '分类' ? '#5d6bff' : '#f05b67', expiresAt: '', enabled: true });
  dialogVisible.value = true;
};

const save = async () => {
  if (!form.name.trim() || !form.localeName.trim()) return ElMessage.warning('请填写英文名称和本地化名称');
  const duplicate = state.value.taxonomy.some((item) => item.id !== editingId.value && item.type === activeType.value && item.name.toLowerCase() === form.name.trim().toLowerCase());
  if (duplicate) return ElMessage.warning('该名称已存在');
  const candidate = state.value.taxonomy.map((item) => ({ ...item }));
  if (editingId.value) {
    const item = candidate.find((row) => row.id === editingId.value);
    if (!item) return;
    Object.assign(item, { ...form, name: form.name.trim(), localeName: form.localeName.trim(), expiresAt: form.expiresAt || '—' });
  } else {
    candidate.push({ id: `${activeType.value === '分类' ? 'tax' : 'tag'}-${Date.now()}`, type: activeType.value, name: form.name.trim(), localeName: form.localeName.trim(), color: form.color, expiresAt: form.expiresAt || '—', enabled: form.enabled, contentCount: 0 });
  }
  saving.value = true;
  try {
    state.value.taxonomy = (await api.saveTaxonomy(candidate)).items;
    dialogVisible.value = false;
    ElMessage.success(`${activeType.value}已保存并同步到服务端`);
  } catch (reason: any) {
    ElMessage.error(reason?.data?.statusMessage || `${activeType.value}保存失败`);
  } finally {
    saving.value = false;
  }
};

const toggle = async (item: TaxonomyItem) => {
  try {
    state.value.taxonomy = (await api.saveTaxonomy(state.value.taxonomy)).items;
    ElMessage.success(`${item.name} 已${item.enabled ? '启用' : '停用'}`);
  } catch (reason: any) {
    item.enabled = !item.enabled;
    ElMessage.error(reason?.data?.statusMessage || '状态更新失败');
  }
};

const remove = async (item: TaxonomyItem) => {
  if (item.contentCount) return ElMessage.warning(`该${item.type}仍关联 ${item.contentCount} 部短剧，请先解除关联`);
  await ElMessageBox.confirm(`确定删除“${item.name}”吗？`, `删除${item.type}`, { type: 'warning' });
  try {
    state.value.taxonomy = (await api.saveTaxonomy(state.value.taxonomy.filter((row) => row.id !== item.id))).items;
    ElMessage.success('已删除');
  } catch (reason: any) {
    ElMessage.error(reason?.data?.statusMessage || '删除失败');
  }
};
</script>

<template>
  <div>
    <AdminPageHeader title="分类与标签" description="维护内容分类、多语言名称、标签颜色和有效期。"><el-button type="primary" @click="openEditor()"><Plus :size="16" />新增{{ activeType }}</el-button></AdminPageHeader>
    <section class="admin-panel admin-filter-panel"><div class="admin-filter-row"><el-segmented v-model="activeType" :options="['分类', '标签']" /><el-input v-model="keyword" clearable placeholder="搜索名称" class="admin-filter-search"><template #prefix><Search :size="16" /></template></el-input><span class="admin-filter-spacer" /><span class="filter-summary">{{ rows.length }} 个{{ activeType }}</span></div></section>
    <section class="admin-panel admin-table-panel"><el-table v-loading="loading" :data="rows" row-key="id"><el-table-column label="名称" min-width="210"><template #default="scope"><div class="taxonomy-name"><span class="taxonomy-swatch" :style="{ background: scope.row.color }"><Palette :size="14" /></span><div><strong>{{ scope.row.name }}</strong><span>{{ scope.row.localeName }}</span></div></div></template></el-table-column><el-table-column label="类型" width="90"><template #default="scope"><el-tag effect="plain">{{ scope.row.type }}</el-tag></template></el-table-column><el-table-column prop="contentCount" label="关联内容" width="110" /><el-table-column label="有效期" min-width="130"><template #default="scope">{{ scope.row.expiresAt }}</template></el-table-column><el-table-column label="状态" width="100"><template #default="scope"><el-switch v-model="scope.row.enabled" @change="toggle(scope.row)" /></template></el-table-column><el-table-column label="操作" fixed="right" width="130"><template #default="scope"><el-button link type="primary" @click="openEditor(scope.row)">编辑</el-button><el-button link :icon="Trash2" @click="remove(scope.row)">删除</el-button></template></el-table-column></el-table><div class="admin-pagination"><span>共 {{ rows.length }} 条</span></div></section>
    <el-dialog v-model="dialogVisible" :title="`${editingId ? '编辑' : '新增'}${activeType}`" width="min(520px, 92vw)"><el-form label-position="top"><div class="form-grid"><el-form-item label="英文名称" required><el-input v-model="form.name" /></el-form-item><el-form-item label="本地化名称" required><el-input v-model="form.localeName" /></el-form-item></div><div class="form-grid"><el-form-item label="标识颜色"><el-color-picker v-model="form.color" show-alpha /><span class="color-value">{{ form.color }}</span></el-form-item><el-form-item v-if="activeType === '标签'" label="有效期"><el-date-picker v-model="form.expiresAt" type="date" value-format="YYYY-MM-DD" placeholder="永久有效" style="width: 100%" /></el-form-item></div><el-form-item label="启用状态"><el-switch v-model="form.enabled" /></el-form-item></el-form><template #footer><el-button @click="dialogVisible = false">取消</el-button><el-button type="primary" :loading="saving" @click="save">保存</el-button></template></el-dialog>
  </div>
</template>
