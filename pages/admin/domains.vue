<script setup lang="ts">
import {
  CheckCircle2,
  Cloud,
  Copy,
  ExternalLink,
  Globe2,
  Plus,
  RefreshCw,
  Route,
  Settings2,
  ShieldCheck,
  Trash2,
} from 'lucide-vue-next';
import { ElMessage, ElMessageBox } from 'element-plus';
import type { DomainConfig } from '~/composables/useAdminStore';

definePageMeta({ layout: 'admin' });

const { state } = useAdminStore();
const api = useAdminApi();
const dialogVisible = ref(false);
const settingsVisible = ref(false);
const dnsVisible = ref(false);
const verifying = ref('');
const redirecting = ref('');
const deleting = ref('');
const loading = ref(true);
const adding = ref(false);
const savingSettings = ref(false);
const cnameTarget = ref('');
const automationConfigured = ref(false);
const saasEnabled = ref(false);
const saasStatus = ref<'已开通' | '待 Cloudflare for SaaS 开通'>('待 Cloudflare for SaaS 开通');
const missingFields = ref<Array<'zoneId' | 'apiToken' | 'cnameTarget'>>([]);
const domainSettings = reactive({ zoneId: '', cnameTarget: '', apiTokenConfigured: false });
const activeDomain = ref<DomainConfig | null>(null);
const form = reactive({ host: '' });

const mvpDomains = [
  {
    host: 'iseedrama.com',
    purpose: '用户 H5 与同源 API',
    target: 'Nuxt 部署',
    behavior: '普通 Custom Domain，作为唯一主域名',
    label: '主站',
  },
  {
    host: 'admin.iseedrama.com',
    purpose: '运营管理后台',
    target: '同一 Nuxt 部署',
    behavior: '根路径自动进入 /admin',
    label: '后台',
  },
  {
    host: 'media.iseedrama.com',
    purpose: 'R2 / Stream 媒体服务',
    target: 'reelnova-media Worker',
    behavior: 'Worker Custom Domain',
    label: '媒体',
  },
  {
    host: 'www.iseedrama.com',
    purpose: '兼容访问入口',
    target: 'Cloudflare Redirect Rule',
    behavior: '301 到根域名，保留路径与查询参数',
    label: '301',
  },
];

const loadDomains = async () => {
  loading.value = true;
  try {
    const response = await api.getDomains();
    state.value.domains = response.items;
    Object.assign(domainSettings, response.settings);
    cnameTarget.value = response.settings.cnameTarget;
    missingFields.value = response.missingFields;
    automationConfigured.value = response.automationConfigured;
    saasEnabled.value = response.saasEnabled;
    saasStatus.value = response.saasStatus;
  } catch {
    ElMessage.error('域名配置加载失败');
  } finally {
    loading.value = false;
  }
};

onMounted(loadDomains);

const missingFieldLabels: Record<'zoneId' | 'apiToken' | 'cnameTarget', string> = {
  zoneId: 'Zone ID',
  apiToken: 'API Token（服务端 Secret）',
  cnameTarget: 'CNAME 接入目标',
};
const missingConfigurationText = computed(() => `还需配置：${missingFields.value.map((field) => missingFieldLabels[field]).join('、')}`);

const saveSettings = async () => {
  savingSettings.value = true;
  try {
    const response = await api.saveDomainSettings({ zoneId: domainSettings.zoneId, cnameTarget: domainSettings.cnameTarget });
    Object.assign(domainSettings, response.settings);
    cnameTarget.value = response.settings.cnameTarget;
    missingFields.value = response.missingFields;
    automationConfigured.value = response.automationConfigured;
    settingsVisible.value = false;
    ElMessage.success(response.automationConfigured ? '域名接入设置已保存并验证' : '域名接入设置已保存');
  } catch (reason: any) {
    ElMessage.error(reason?.data?.statusMessage || '域名接入设置保存失败');
  } finally {
    savingSettings.value = false;
  }
};

const addDomain = async () => {
  const host = form.host.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');
  if (!/^(?:[a-z0-9-]+\.)+[a-z]{2,}$/.test(host)) return ElMessage.warning('请输入有效域名，不包含路径');
  if (state.value.domains.some((item) => item.host === host)) return ElMessage.warning('该域名已存在');
  adding.value = true;
  try {
    state.value.domains.push(await api.addDomain(host));
    dialogVisible.value = false;
    form.host = '';
    ElMessage.success('Cloudflare 自定义域名已创建，请完成 DNS 与证书验证');
  } catch (reason: any) {
    ElMessage.error(reason?.data?.statusMessage || '域名添加失败');
  } finally {
    adding.value = false;
  }
};

const showDns = (domain: DomainConfig) => {
  activeDomain.value = domain;
  dnsVisible.value = true;
};
const copy = async (value: string) => {
  await navigator.clipboard.writeText(value);
  ElMessage.success('记录值已复制');
};
const verify = async (domain: DomainConfig) => {
  verifying.value = domain.id;
  try {
    const updated = await api.verifyDomain(domain.id);
    Object.assign(domain, updated);
    ElMessage.success(updated.certificate === '正常' ? 'DNS 与 HTTPS 验证通过' : 'DNS 验证通过，HTTPS 证书正在签发');
  } catch (reason: any) {
    await loadDomains();
    ElMessage.error(reason?.data?.statusMessage || 'DNS 验证失败');
  } finally {
    verifying.value = '';
  }
};

const setPrimary = async (domain: DomainConfig) => {
  if (domain.verification !== '已验证' || domain.certificate !== '正常') return ElMessage.warning('域名验证与 HTTPS 证书正常后才能设为主域名');
  await ElMessageBox.confirm('切换主域名会影响分享链接、PayPal 回调白名单和旧域名跳转。请确认发布检查清单已完成。', '切换主域名', { type: 'warning', confirmButtonText: '确认切换' });
  try {
    await api.updateDomain(domain.id, { action: 'set-primary' });
    await loadDomains();
    ElMessage.success('主域名已切换');
  } catch (reason: any) {
    ElMessage.error(reason?.data?.statusMessage || '主域名切换失败');
  }
};

const toggleRedirect = async (domain: DomainConfig) => {
  if (domain.role === '主域名' && domain.redirect) {
    domain.redirect = false;
    return ElMessage.warning('主域名不能跳转到自身');
  }
  redirecting.value = domain.id;
  try {
    Object.assign(domain, await api.updateDomain(domain.id, { action: 'set-redirect', redirect: domain.redirect }));
    ElMessage.success(domain.redirect ? '旧域名 301 已启用' : '旧域名 301 已关闭');
  } catch (reason: any) {
    domain.redirect = !domain.redirect;
    ElMessage.error(reason?.data?.statusMessage || '跳转策略更新失败');
  } finally {
    redirecting.value = '';
  }
};

const cloudflareStatusLabels: Record<string, string> = {
  active: '路由已激活',
  pending: '等待验证',
  moved: '已迁移',
  blocked: '已阻止',
  deleted: '已删除',
};
const cloudflareStatusLabel = (status?: string) => cloudflareStatusLabels[status || ''] || (status ? `异常：${status}` : '未绑定');

const removeDomain = async (domain: DomainConfig) => {
  await ElMessageBox.confirm(`将同时删除 ${domain.host} 的 Cloudflare Custom Hostname，证书和流量入口会立即失效。`, '解除域名绑定', { type: 'error', confirmButtonText: '确认解除' });
  deleting.value = domain.id;
  try {
    await api.deleteDomain(domain.id);
    await loadDomains();
    ElMessage.success('域名绑定已解除');
  } catch (reason: any) {
    ElMessage.error(reason?.data?.statusMessage || '解除域名绑定失败');
  } finally {
    deleting.value = '';
  }
};
</script>

<template>
  <div>
    <AdminPageHeader
      title="域名管理"
      :description="saasEnabled ? 'Cloudflare for SaaS 自定义域名、证书与主域切换。' : 'MVP 使用普通 Cloudflare Custom Domains，动态备用域名暂不开放。'"
    >
      <el-button v-if="saasEnabled" @click="settingsVisible = true"><Settings2 :size="16" />接入设置</el-button>
      <el-button v-if="saasEnabled" type="primary" :disabled="!automationConfigured" @click="dialogVisible = true"><Plus :size="16" />绑定域名</el-button>
      <el-button v-else disabled title="待 Cloudflare for SaaS 开通"><Plus :size="16" />动态添加备用域名</el-button>
    </AdminPageHeader>

    <section v-if="loading" class="admin-panel admin-data-state"><el-skeleton :rows="6" animated /></section>

    <template v-else-if="!saasEnabled">
      <el-alert
        title="当前模式：自有域名直接绑定"
        type="info"
        show-icon
        :closable="false"
        class="admin-alert"
      >
        <template #default>当前正式域名可完成证书与 301 验收；任意第三方备用域名自动接入待 Cloudflare for SaaS 开通。</template>
      </el-alert>

      <section class="admin-panel domain-plan">
        <div class="admin-panel__header">
          <div><h2>正式域名部署</h2><p>在 Cloudflare 项目中完成绑定和规则配置</p></div>
          <el-tag type="primary">MVP</el-tag>
        </div>
        <div class="domain-plan__list">
          <article v-for="item in mvpDomains" :key="item.host" class="domain-plan__row">
            <span class="domain-plan__icon"><Route v-if="item.host.startsWith('www.')" :size="19" /><Cloud v-else :size="19" /></span>
            <div class="domain-plan__identity"><strong>{{ item.host }}</strong><span>{{ item.purpose }}</span></div>
            <div class="domain-plan__target"><span>绑定目标</span><strong>{{ item.target }}</strong></div>
            <div class="domain-plan__behavior"><span>行为</span><strong>{{ item.behavior }}</strong></div>
            <el-tag type="info" effect="plain">{{ item.label }}</el-tag>
          </article>
        </div>
        <div class="domain-plan__footer">
          <span>域名绑定与 Redirect Rule 需在 Cloudflare 控制台完成</span>
          <a class="el-button el-button--primary" href="https://dash.cloudflare.com/" target="_blank" rel="noreferrer">打开 Cloudflare<ExternalLink :size="15" /></a>
        </div>
      </section>

      <section class="admin-panel saas-gate">
        <div class="admin-panel__header">
          <div><h2>动态备用域名</h2><p>后台自动接入任意第三方域名</p></div>
          <el-tag type="warning" effect="dark">{{ saasStatus }}</el-tag>
        </div>
        <div class="saas-gate__content">
          <ShieldCheck :size="28" />
          <div>
            <strong>开通后再启用自动化</strong>
            <span>配置 fallback origin、统一 CNAME hostname 和 Custom Hostnames 配额后，将 <code>CLOUDFLARE_FOR_SAAS_ENABLED</code> 设为 <code>true</code>。</span>
          </div>
        </div>
      </section>
    </template>

    <template v-else>
      <el-alert v-if="!automationConfigured && !loading" :title="missingConfigurationText" type="warning" show-icon :closable="false" class="admin-alert">
        <template #default><span>Zone ID 与 CNAME 目标可在接入设置中维护；API Token 为敏感凭据，只能通过服务端 Secret 配置。</span><el-button link type="primary" @click="settingsVisible = true">打开接入设置</el-button></template>
      </el-alert>
      <el-alert title="切换主域名前，请同步更新 PayPal 回调白名单、Webhook URL、CDN CORS 与分享链接回归测试。" type="warning" show-icon :closable="false" class="admin-alert" />
      <el-empty v-if="!state.domains.length" description="尚未绑定自定义域名"><el-button type="primary" :disabled="!automationConfigured" @click="dialogVisible = true">绑定域名</el-button></el-empty>
      <section v-else class="domain-grid">
        <article v-for="domain in state.domains" :key="domain.id" class="admin-panel domain-card">
          <div class="domain-card__header"><span class="domain-icon"><Globe2 :size="20" /></span><div><strong>{{ domain.host }}</strong><span>Custom Hostname {{ domain.cloudflareHostnameId || '未创建' }}</span></div><el-tag :type="domain.role === '主域名' ? 'primary' : 'info'">{{ domain.role }}</el-tag></div>
          <div class="domain-health"><div><span>Cloudflare 路由</span><strong :class="domain.cloudflareStatus === 'active' ? 'success-text' : 'warning-text'">{{ cloudflareStatusLabel(domain.cloudflareStatus) }}</strong></div><div><span>CNAME 验证</span><strong :class="domain.verification === '已验证' ? 'success-text' : 'warning-text'"><CheckCircle2 v-if="domain.verification === '已验证'" :size="15" />{{ domain.verification }}</strong></div><div><span>HTTPS 证书</span><strong :class="domain.certificate === '正常' ? 'success-text' : 'warning-text'"><ShieldCheck :size="15" />{{ domain.certificate }}</strong></div><div><span>301 到主域名</span><el-switch v-model="domain.redirect" :loading="redirecting === domain.id" :disabled="domain.role === '主域名'" @change="toggleRedirect(domain)" /></div></div>
          <p v-if="domain.provisioningError" class="domain-error">{{ domain.provisioningError }}</p>
          <div class="domain-card__footer"><span>更新于 {{ new Date(domain.updatedAt).toLocaleString('zh-CN', { hour12: false }) }}</span><div><el-button link @click="showDns(domain)">DNS 配置</el-button><el-button link type="primary" :loading="verifying === domain.id" @click="verify(domain)"><RefreshCw :size="14" />同步状态</el-button><el-button v-if="domain.verification === '已验证' && domain.certificate === '正常' && domain.role !== '主域名'" link type="primary" @click="setPrimary(domain)">设为主域名</el-button><el-button v-if="domain.role !== '主域名'" link type="danger" :loading="deleting === domain.id" title="解除域名绑定" @click="removeDomain(domain)"><Trash2 :size="14" /></el-button></div></div>
        </article>
      </section>
    </template>

    <el-dialog v-if="saasEnabled" v-model="dialogVisible" title="绑定自定义域名" width="min(500px, 92vw)">
      <el-form label-position="top"><el-form-item label="域名" required><el-input v-model="form.host" placeholder="backup.example.com" /></el-form-item><el-alert title="确认后会立即创建 Cloudflare Custom Hostname 并申请 DV 证书；验证通过前只作为备用域名。" type="info" :closable="false" /></el-form>
      <template #footer><el-button @click="dialogVisible = false">取消</el-button><el-button type="primary" :loading="adding" @click="addDomain">创建绑定</el-button></template>
    </el-dialog>
    <el-dialog v-if="saasEnabled" v-model="settingsVisible" title="域名接入设置" width="min(560px, 92vw)">
      <el-form label-position="top"><el-form-item label="Cloudflare Zone ID" required><el-input v-model="domainSettings.zoneId" maxlength="32" placeholder="32 位 Zone ID" /></el-form-item><el-form-item label="SaaS CNAME 接入目标" required><el-input v-model="domainSettings.cnameTarget" placeholder="customers.example.com" /><div class="domain-setting-help">客户域名需要 CNAME 指向此主机名，不包含协议和路径。</div></el-form-item><div class="domain-secret-status"><span>Cloudflare API Token</span><el-tag :type="domainSettings.apiTokenConfigured ? 'success' : 'warning'">{{ domainSettings.apiTokenConfigured ? '服务端已配置' : '服务端未配置' }}</el-tag><p>Token 不在后台显示或保存，请通过部署环境的 <code>CLOUDFLARE_API_TOKEN</code> Secret 管理。</p></div></el-form>
      <template #footer><el-button @click="settingsVisible = false">取消</el-button><el-button type="primary" :loading="savingSettings" @click="saveSettings">保存并验证</el-button></template>
    </el-dialog>
    <el-drawer v-if="saasEnabled" v-model="dnsVisible" title="DNS 与证书验证" size="min(560px, 92vw)">
      <template v-if="activeDomain"><el-alert title="在域名服务商处添加 CNAME；Cloudflare 返回 TXT 记录时也必须一并添加。" type="info" :closable="false" show-icon /><h3 class="dns-section-title">流量接入</h3><div class="dns-record"><span>记录名称</span><strong>{{ activeDomain.host }}</strong><button type="button" title="复制" @click="copy(activeDomain.host)"><Copy :size="15" /></button></div><div class="dns-record"><span>记录类型</span><strong>CNAME</strong><button type="button" title="复制" @click="copy('CNAME')"><Copy :size="15" /></button></div><div class="dns-record"><span>记录值</span><strong>{{ cnameTarget }}</strong><button type="button" title="复制" @click="copy(cnameTarget)"><Copy :size="15" /></button></div><template v-if="activeDomain.validationRecords?.length"><h3 class="dns-section-title">证书验证</h3><template v-for="record in activeDomain.validationRecords" :key="`${record.name}:${record.value}`"><div class="dns-record"><span>{{ record.type }} 名称</span><strong>{{ record.name }}</strong><button type="button" title="复制" @click="copy(record.name)"><Copy :size="15" /></button></div><div class="dns-record"><span>{{ record.type }} 值</span><strong>{{ record.value }}</strong><button type="button" title="复制" @click="copy(record.value)"><Copy :size="15" /></button></div></template></template><el-button type="primary" :loading="verifying === activeDomain.id" @click="verify(activeDomain)"><RefreshCw :size="15" />同步 Cloudflare 状态</el-button></template>
    </el-drawer>
  </div>
</template>
