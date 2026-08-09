<script setup lang="ts">
import { CheckCircle2, Copy, Globe2, Plus, RefreshCw, ShieldCheck } from 'lucide-vue-next';
import { ElMessage, ElMessageBox } from 'element-plus';
import type { DomainConfig } from '~/composables/useAdminStore';

definePageMeta({ layout: 'admin' });

const { state, addAudit } = useAdminStore();
const dialogVisible = ref(false);
const dnsVisible = ref(false);
const verifying = ref('');
const activeDomain = ref<DomainConfig | null>(null);
const form = reactive({ host: '', role: '备用域名' as DomainConfig['role'] });

const addDomain = () => {
  const host = form.host.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');
  if (!/^(?:[a-z0-9-]+\.)+[a-z]{2,}$/.test(host)) return ElMessage.warning('请输入有效域名，不包含路径');
  if (state.value.domains.some((item) => item.host === host)) return ElMessage.warning('该域名已存在');
  state.value.domains.push({ id: `dom-${Date.now()}`, host, role: '备用域名', verification: '待验证', certificate: '未签发', redirect: false, updatedAt: new Date().toLocaleString('zh-CN', { hour12: false }).replaceAll('/', '-') });
  addAudit({ module: '域名管理', action: '添加域名', target: host, detail: `${form.role === '主域名' ? '主域名候选' : '备用域名'}，等待 DNS 验证`, risk: '高风险' });
  dialogVisible.value = false;
  form.host = '';
  ElMessage.success('域名已添加，请完成 DNS 配置后再切换主域名');
};

const showDns = (domain: DomainConfig) => { activeDomain.value = domain; dnsVisible.value = true; };
const copy = async (text: string) => { await navigator.clipboard.writeText(text); ElMessage.success('记录值已复制'); };
const verify = async (domain: DomainConfig) => {
  verifying.value = domain.id;
  await new Promise((resolve) => window.setTimeout(resolve, 900));
  verifying.value = '';
  domain.verification = '已验证';
  domain.certificate = '正常';
  domain.updatedAt = new Date().toLocaleString('zh-CN', { hour12: false }).replaceAll('/', '-');
  addAudit({ module: '域名管理', action: '验证域名', target: domain.host, detail: 'DNS 与 HTTPS 证书验证通过', risk: '高风险' });
  ElMessage.success('DNS 验证通过，HTTPS 证书已签发');
};

const setPrimary = async (domain: DomainConfig) => {
  if (domain.verification !== '已验证' || domain.certificate !== '正常') return ElMessage.warning('域名验证与 HTTPS 证书正常后才能设为主域名');
  const before = state.value.domains.find((item) => item.role === '主域名');
  await ElMessageBox.confirm('切换主域名会影响分享链接、PayPal 回调白名单和旧域名跳转。请确认发布检查清单已完成。', '切换主域名', { type: 'warning', confirmButtonText: '确认切换' });
  state.value.domains.forEach((item) => item.role = item.id === domain.id ? '主域名' : '备用域名');
  addAudit({ module: '域名管理', action: '切换主域名', target: domain.host, detail: `${before?.host || '—'} → ${domain.host}`, risk: '高风险' });
  ElMessage.success('主域名已切换');
};

const toggleRedirect = (domain: DomainConfig) => {
  if (domain.role === '主域名' && domain.redirect) { domain.redirect = false; return ElMessage.warning('主域名不能跳转到自身'); }
  addAudit({ module: '域名管理', action: '更新跳转策略', target: domain.host, detail: domain.redirect ? '启用 301 到主域名' : '关闭 301 跳转', risk: '高风险' });
  ElMessage.success('跳转策略已更新');
};
</script>

<template>
  <div>
    <AdminPageHeader title="域名管理" description="管理主备域名、DNS 验证、HTTPS 证书和迁移跳转策略。"><el-button type="primary" @click="dialogVisible = true"><Plus :size="16" />绑定域名</el-button></AdminPageHeader>
    <el-alert title="切换主域名前，请同步更新 PayPal 回调白名单、Webhook URL、CDN CORS 与分享链接回归测试。" type="warning" show-icon :closable="false" class="admin-alert" />
    <section class="domain-grid"><article v-for="domain in state.domains" :key="domain.id" class="admin-panel domain-card"><div class="domain-card__header"><span class="domain-icon"><Globe2 :size="20" /></span><div><strong>{{ domain.host }}</strong><span>{{ domain.role }}</span></div><el-tag :type="domain.role === '主域名' ? 'primary' : 'info'">{{ domain.role }}</el-tag></div><div class="domain-health"><div><span>域名验证</span><strong :class="domain.verification === '已验证' ? 'success-text' : 'warning-text'"><CheckCircle2 v-if="domain.verification === '已验证'" :size="15" />{{ domain.verification }}</strong></div><div><span>HTTPS 证书</span><strong :class="domain.certificate === '正常' ? 'success-text' : 'warning-text'"><ShieldCheck :size="15" />{{ domain.certificate }}</strong></div><div><span>301 到主域名</span><el-switch v-model="domain.redirect" :disabled="domain.role === '主域名'" @change="toggleRedirect(domain)" /></div></div><div class="domain-card__footer"><span>更新于 {{ domain.updatedAt }}</span><div><el-button link @click="showDns(domain)">DNS 配置</el-button><el-button v-if="domain.verification !== '已验证'" link type="primary" :loading="verifying === domain.id" @click="verify(domain)"><RefreshCw :size="14" />验证</el-button><el-button v-else-if="domain.role !== '主域名'" link type="primary" @click="setPrimary(domain)">设为主域名</el-button></div></div></article></section>
    <el-dialog v-model="dialogVisible" title="绑定自定义域名" width="min(500px, 92vw)"><el-form label-position="top"><el-form-item label="域名" required><el-input v-model="form.host" placeholder="watch.example.com" /></el-form-item><el-form-item label="域名角色"><el-radio-group v-model="form.role"><el-radio value="备用域名">备用域名</el-radio><el-radio value="主域名">主域名候选</el-radio></el-radio-group></el-form-item></el-form><template #footer><el-button @click="dialogVisible = false">取消</el-button><el-button type="primary" @click="addDomain">添加并配置 DNS</el-button></template></el-dialog>
    <el-drawer v-model="dnsVisible" title="DNS 配置" size="min(520px, 92vw)"><template v-if="activeDomain"><el-alert title="请在域名服务商处添加以下 CNAME 记录。解析生效通常需要 5 分钟至 24 小时。" type="info" :closable="false" show-icon /><div class="dns-record"><span>主机记录</span><strong>{{ activeDomain.host.split('.')[0] }}</strong><button type="button" title="复制" @click="copy(activeDomain.host.split('.')[0])"><Copy :size="15" /></button></div><div class="dns-record"><span>记录类型</span><strong>CNAME</strong><button type="button" title="复制" @click="copy('CNAME')"><Copy :size="15" /></button></div><div class="dns-record"><span>记录值</span><strong>domains.reelnova-edge.net</strong><button type="button" title="复制" @click="copy('domains.reelnova-edge.net')"><Copy :size="15" /></button></div><el-button type="primary" :loading="verifying === activeDomain.id" @click="verify(activeDomain)"><RefreshCw :size="15" />立即验证</el-button></template></el-drawer>
  </div>
</template>
