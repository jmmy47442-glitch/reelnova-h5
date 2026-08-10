<script setup lang="ts">
import { CheckCircle2, Copy, Plus, ShieldCheck, ShieldOff, Trash2, UserCog } from 'lucide-vue-next';
import { ElMessage, ElMessageBox } from 'element-plus';
import type { AdminAccount } from '~/types/admin';

definePageMeta({ layout: 'admin' });
useHead({ title: '管理员账号 · ReelNova Admin' });

const api = useAdminApi();
const { data, status, refresh } = await useAsyncData('admin-accounts', () => api.getAdministrators());
const dialogVisible = ref(false);
const submitting = ref(false);
const changingId = ref('');
const deletingId = ref('');
const createdCredentials = ref<{ name: string; email: string; password: string } | null>(null);
const form = reactive({ name: '', email: '' });
const rows = computed(() => data.value?.items || []);

const formatDate = (value: string | null) => value
  ? new Date(value).toLocaleString('zh-CN', { hour12: false }).replaceAll('/', '-')
  : '尚未登录';

const openCreate = () => {
  form.name = '';
  form.email = '';
  createdCredentials.value = null;
  dialogVisible.value = true;
};

const createAdministrator = async () => {
  if (!form.name.trim()) return ElMessage.warning('请输入管理员姓名');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) return ElMessage.warning('请输入有效邮箱地址');
  submitting.value = true;
  try {
    const result = await api.createAdministrator({ name: form.name.trim(), email: form.email.trim().toLowerCase() });
    createdCredentials.value = { name: result.account.name, email: result.account.email, password: result.initialPassword };
    await refresh();
    ElMessage.success('管理员账号已创建');
  } catch (error: unknown) {
    const statusCode = (error as { statusCode?: number; response?: { status?: number } }).statusCode
      || (error as { response?: { status?: number } }).response?.status;
    ElMessage.error(statusCode === 409 ? '该邮箱已是管理员账号' : '创建失败，请稍后重试');
  } finally {
    submitting.value = false;
  }
};

const copy = async (value: string, label: string) => {
  await navigator.clipboard.writeText(value);
  ElMessage.success(`${label}已复制`);
};

const copyCredentials = async () => {
  if (!createdCredentials.value) return;
  const { name, email, password } = createdCredentials.value;
  await copy(`ReelNova 管理后台\n姓名：${name}\n登录邮箱：${email}\n初始密码：${password}`, '登录信息');
};

const changeStatus = async (account: AdminAccount) => {
  const nextStatus = account.status === 'disabled' ? 'active' : 'disabled';
  const action = nextStatus === 'disabled' ? '停用' : '恢复';
  await ElMessageBox.confirm(
    nextStatus === 'disabled' ? `停用后，${account.name} 将无法继续登录后台。` : `恢复 ${account.name} 的后台登录权限？`,
    `${action}管理员`,
    { type: nextStatus === 'disabled' ? 'warning' : 'info', confirmButtonText: `确认${action}` },
  );
  changingId.value = account.id;
  try {
    await api.updateAdministratorStatus(account.id, nextStatus);
    await refresh();
    ElMessage.success(`管理员已${action}`);
  } finally {
    changingId.value = '';
  }
};

const deleteAdministrator = async (account: AdminAccount) => {
  await ElMessageBox.confirm(
    `删除后，${account.name}（${account.email}）将无法登录，该账号也无法恢复。`,
    '删除管理员',
    { type: 'error', confirmButtonText: '确认删除', cancelButtonText: '取消' },
  );
  deletingId.value = account.id;
  try {
    await api.deleteAdministrator(account.id);
    await refresh();
    ElMessage.success('管理员账号已删除');
  } catch {
    ElMessage.error('删除失败，请稍后重试');
  } finally {
    deletingId.value = '';
  }
};
</script>

<template>
  <div>
    <AdminPageHeader title="管理员账号" description="由超级管理员创建账号、转交初始密码并控制登录权限。"><el-button type="primary" @click="openCreate"><Plus :size="16" />创建管理员</el-button></AdminPageHeader>
    <el-alert title="登录密码仅在创建成功时显示一次。请通过可信渠道转交并妥善保管。" type="warning" show-icon :closable="false" class="admin-alert" />

    <section class="admin-panel admin-table-panel">
      <el-table v-loading="status === 'pending'" :data="rows" row-key="id">
        <el-table-column label="管理员" min-width="220"><template #default="scope"><div class="administrator-identity"><span><ShieldCheck v-if="scope.row.role === 'super_admin'" :size="17" /><UserCog v-else :size="17" /></span><div><strong>{{ scope.row.name }}</strong><small>{{ scope.row.email }}</small></div></div></template></el-table-column>
        <el-table-column label="角色" width="120"><template #default="scope"><el-tag :type="scope.row.role === 'super_admin' ? 'danger' : 'info'" effect="plain">{{ scope.row.role === 'super_admin' ? '超级管理员' : '管理员' }}</el-tag></template></el-table-column>
        <el-table-column label="状态" width="110"><template #default="scope"><span class="administrator-status" :class="scope.row.status"><i />{{ scope.row.status === 'active' ? '正常' : scope.row.status === 'invited' ? '待首次登录' : '已停用' }}</span></template></el-table-column>
        <el-table-column label="最近登录" min-width="170"><template #default="scope">{{ formatDate(scope.row.lastLoginAt) }}</template></el-table-column>
        <el-table-column label="创建时间" min-width="170"><template #default="scope">{{ formatDate(scope.row.createdAt) }}</template></el-table-column>
        <el-table-column label="操作" fixed="right" width="190"><template #default="scope"><div v-if="scope.row.role !== 'super_admin'" class="administrator-actions"><el-button link :type="scope.row.status === 'disabled' ? 'success' : 'danger'" :loading="changingId === scope.row.id" :disabled="deletingId === scope.row.id" @click="changeStatus(scope.row)"><CheckCircle2 v-if="scope.row.status === 'disabled'" :size="14" /><ShieldOff v-else :size="14" />{{ scope.row.status === 'disabled' ? '恢复' : '停用' }}</el-button><el-button link type="danger" :loading="deletingId === scope.row.id" :disabled="changingId === scope.row.id" @click="deleteAdministrator(scope.row)"><Trash2 :size="14" />删除</el-button></div><span v-else class="protected-account">受保护</span></template></el-table-column>
      </el-table>
      <div class="admin-pagination"><span>共 {{ rows.length }} 个管理员账号</span><span>超级管理员不可停用或删除</span></div>
    </section>

    <el-dialog v-model="dialogVisible" :title="createdCredentials ? '管理员已创建' : '创建管理员'" width="min(520px, 92vw)" :close-on-click-modal="!createdCredentials">
      <template v-if="!createdCredentials">
        <el-form label-position="top" @submit.prevent="createAdministrator">
          <el-form-item label="管理员姓名" required><el-input v-model="form.name" maxlength="80" placeholder="例如：Olivia Chen" /></el-form-item>
          <el-form-item label="登录邮箱" required><el-input v-model="form.email" type="email" placeholder="olivia@reelnova.com" /></el-form-item>
        </el-form>
        <el-alert title="系统将自动生成初始密码，创建后由你手动转交给管理员。" type="info" :closable="false" show-icon />
      </template>
      <div v-else class="created-credentials">
        <div class="created-credentials__success"><CheckCircle2 :size="21" /><div><strong>{{ createdCredentials.name }}</strong><span>账号已写入管理员数据库</span></div></div>
        <div class="credential-row"><span>登录邮箱</span><code>{{ createdCredentials.email }}</code><button type="button" title="复制邮箱" @click="copy(createdCredentials.email, '邮箱')"><Copy :size="15" /></button></div>
        <div class="credential-row is-password"><span>初始密码</span><code>{{ createdCredentials.password }}</code><button type="button" title="复制密码" @click="copy(createdCredentials.password, '密码')"><Copy :size="15" /></button></div>
        <p>关闭窗口后无法再次查看该密码。</p>
      </div>
      <template #footer><template v-if="!createdCredentials"><el-button @click="dialogVisible = false">取消</el-button><el-button type="primary" :loading="submitting" @click="createAdministrator">创建账号</el-button></template><template v-else><el-button @click="copyCredentials"><Copy :size="15" />复制登录信息</el-button><el-button type="primary" @click="dialogVisible = false">完成</el-button></template></template>
    </el-dialog>
  </div>
</template>
