<script setup lang="ts">
import { CheckCircle2, Cloud, Copy, Database, ExternalLink, RefreshCw, ShieldAlert, Video } from 'lucide-vue-next';
import { ElMessage, ElMessageBox } from 'element-plus';

definePageMeta({ layout: 'admin' });
const api = useAdminApi();
const { data, status, refresh } = await useAsyncData('admin-real-connection', () => api.getConnection());
const copyValue = async (value: string) => { await navigator.clipboard.writeText(value); ElMessage.success('已复制'); };
const webhookUrl = computed(() => import.meta.client ? `${window.location.origin}/api/paypal/webhook` : '/api/paypal/webhook');
const productionReady = computed(() => Boolean(data.value?.cloudflare.database && data.value?.cloudflare.mediaConfigured
  && data.value?.cloudflare.customHostnamesConfigured && data.value?.paypal.ready));
const paypalTagType = computed(() => !data.value?.paypal.credentialsConfigured ? 'warning' : data.value?.paypal.ready ? 'success' : 'danger');
const paypalTagLabel = computed(() => !data.value?.paypal.credentialsConfigured ? '待配置' : data.value?.paypal.ready ? '已就绪' : '配置未完成');
const retryingWebhook = ref('');
const switchingEnvironment = ref(false);
const selectedEnvironment = ref<'sandbox' | 'production'>('sandbox');
watch(() => data.value?.paypal.environment, (environment) => {
  if (environment === 'sandbox' || environment === 'production') selectedEnvironment.value = environment;
}, { immediate: true });
const targetEnvironmentReady = computed(() => {
  const target = data.value?.paypal.environments?.[selectedEnvironment.value];
  return Boolean(target?.credentialsConfigured && target.browserClientConfigured && target.clientIdsMatch && target.webhookConfigured);
});
const domainMissingLabels: Record<'zoneId' | 'apiToken' | 'cnameTarget', string> = {
  zoneId: 'Zone ID',
  apiToken: 'API Token',
  cnameTarget: 'CNAME 目标',
};
const customHostnamesStatusText = computed(() => {
  if (data.value?.cloudflare.customHostnamesConfigured) return '已配置';
  const missing = data.value?.cloudflare.customHostnamesMissingFields?.map((field) => domainMissingLabels[field]).join(' / ');
  return missing ? `待配置 ${missing}` : '待配置 Zone ID / Token';
});
const streamApiStatusText = computed(() => {
  if (data.value?.cloudflare.streamApiConfigured) return '已配置';
  return data.value?.cloudflare.streamApiError || '待配置 Account ID / Token';
});
const switchEnvironment = async () => {
  const current = data.value?.paypal.environment;
  if (!current || selectedEnvironment.value === current) return;
  const target = selectedEnvironment.value;
  await ElMessageBox.confirm(
    `切换到 ${target === 'production' ? 'Production' : 'Sandbox'} 后，新订单、Capture、退款和 Webhook 验签都会立即使用该环境。`,
    '切换 PayPal 环境',
    { type: 'warning', confirmButtonText: '验证并切换' },
  );
  switchingEnvironment.value = true;
  try {
    await api.switchPayPalEnvironment(target);
    await refresh();
    ElMessage.success(`PayPal 已切换到 ${target}`);
  } catch (reason: any) {
    selectedEnvironment.value = current;
    ElMessage.error(reason?.data?.statusMessage || 'PayPal 环境切换失败');
  } finally { switchingEnvironment.value = false; }
};
const retryWebhook = async (eventId: string) => {
  retryingWebhook.value = eventId;
  try {
    const result = await api.retryPayPalWebhook(eventId);
    ElMessage.success(`Webhook 已${result.status === 'processed' ? '重新处理' : '忽略'}，累计重试 ${result.retryCount} 次`);
    await refresh();
  } catch (reason: any) { ElMessage.error(reason?.data?.statusMessage || 'Webhook 重试失败'); }
  finally { retryingWebhook.value = ''; }
};
</script>

<template>
  <div>
    <AdminPageHeader title="Cloudflare 与支付" description="检查生产链路并切换 PayPal 运行环境；密钥只从 Cloudflare Secrets 读取，后台不回显。"><el-button :loading="status === 'pending'" @click="() => refresh()"><RefreshCw :size="16" />重新检测</el-button></AdminPageHeader>
    <section class="connection-banner" :class="productionReady ? 'is-ok' : 'is-warning'"><span><CheckCircle2 v-if="productionReady" :size="22" /><ShieldAlert v-else :size="22" /></span><div><strong>{{ productionReady ? '生产数据链路已就绪' : '部分生产能力尚待配置' }}</strong><p>{{ data ? `检查时间 ${new Date(data.checkedAt).toLocaleString('zh-CN', { hour12: false })}` : '正在检测 D1、PayPal 和媒体链路' }}</p></div></section>
    <div class="connection-grid">
      <section class="admin-panel connection-panel"><div class="admin-panel__header"><div><h2>Cloudflare D1</h2><p>播放事件、订单、权益和 Webhook 幂等记录</p></div><el-tag :type="data?.cloudflare.database ? 'success' : 'danger'">{{ data?.cloudflare.database ? '已连接' : '未连接' }}</el-tag></div><div class="connection-check"><span><Database :size="18" />数据库查询</span><strong :class="data?.cloudflare.database ? 'success-text' : 'danger-text'">{{ data?.cloudflare.database ? '正常' : data?.cloudflare.databaseError || '失败' }}</strong></div><div class="connection-check"><span>连接方式</span><strong>{{ data?.cloudflare.mode || '检测中' }}</strong></div><div class="connection-check"><span>Account ID</span><strong>{{ data?.cloudflare.accountConfigured || data?.cloudflare.mode === 'D1 binding' ? '已配置' : '缺失' }}</strong></div><div class="connection-check"><span>D1 Database ID</span><strong>{{ data?.cloudflare.databaseConfigured || data?.cloudflare.mode === 'D1 binding' ? '已配置' : '缺失' }}</strong></div><div class="connection-check"><span>API Token</span><strong>{{ data?.cloudflare.apiTokenConfigured || data?.cloudflare.mode === 'D1 binding' ? '已加密配置' : '缺失' }}</strong></div></section>
      <section class="admin-panel connection-panel">
        <div class="admin-panel__header"><div><h2>PayPal Checkout</h2><p>官方 Orders API、Capture 与 Webhook 验签</p></div><el-tag :type="paypalTagType">{{ paypalTagLabel }}</el-tag></div>
        <div class="environment-switcher">
          <div><span>运行环境</span><strong>当前 {{ data?.paypal.environment || '检测中' }}</strong></div>
          <el-radio-group v-model="selectedEnvironment" size="small">
            <el-radio-button value="sandbox">Sandbox</el-radio-button>
            <el-radio-button value="production">Production</el-radio-button>
          </el-radio-group>
          <el-button type="primary" size="small" :disabled="selectedEnvironment === data?.paypal.environment || !targetEnvironmentReady" :loading="switchingEnvironment" @click="switchEnvironment">验证并切换</el-button>
        </div>
        <div class="connection-check"><span><Cloud :size="18" />目标环境配置</span><strong :class="targetEnvironmentReady ? 'success-text' : 'danger-text'">{{ targetEnvironmentReady ? '凭据完整' : '配置不完整' }}</strong></div>
        <div class="connection-check"><span>服务端 Client ID / Secret</span><strong :class="data?.paypal.connected ? 'success-text' : data?.paypal.credentialsConfigured ? 'danger-text' : ''">{{ data?.paypal.connected ? '验证成功' : data?.paypal.error || (data?.paypal.credentialsConfigured ? '验证失败' : '待配置') }}</strong></div>
        <div class="connection-check"><span>浏览器 Client ID</span><strong>{{ data?.paypal.browserClientConfigured ? (data?.paypal.clientIdsMatch ? '已配置且一致' : '与服务端不一致') : '待配置' }}</strong></div>
        <div class="connection-check"><span>Webhook ID</span><strong>{{ data?.paypal.webhookConfigured ? '已配置' : '待配置' }}</strong></div>
        <div class="connection-check"><span>最近 Webhook</span><strong>{{ data?.paypal.lastWebhookAt ? new Date(data.paypal.lastWebhookAt).toLocaleString('zh-CN', { hour12: false }) : '暂无已验证回调' }}</strong></div>
        <div class="connection-copy"><code>{{ webhookUrl }}</code><button type="button" title="复制 Webhook URL" @click="copyValue(webhookUrl)"><Copy :size="15" /></button></div>
      </section>
      <section class="admin-panel connection-panel"><div class="admin-panel__header"><div><h2>Cloudflare 媒体与域名</h2><p>R2、Stream、Custom Hostnames 与证书自动化</p></div><el-tag :type="data?.cloudflare.mediaConfigured && data?.cloudflare.customHostnamesConfigured ? 'success' : 'warning'">{{ data?.cloudflare.mediaConfigured && data?.cloudflare.customHostnamesConfigured ? '已配置' : '待配置' }}</el-tag></div><div class="connection-feature"><Video :size="23" /><div><strong>上传与签名播放</strong><span>原片分片写入私有 R2，Stream 输出自适应 HLS，播放前由服务端校验权益。</span></div></div><div class="connection-check"><span>R2 上传 Worker</span><strong>{{ data?.cloudflare.mediaWorkerConfigured ? '已配置' : '待配置' }}</strong></div><div class="connection-check"><span>Stream API</span><strong :class="data?.cloudflare.streamApiConfigured ? 'success-text' : 'danger-text'">{{ streamApiStatusText }}</strong></div><div class="connection-check"><span>Stream Customer Code</span><strong>{{ data?.cloudflare.streamCustomerCodeConfigured ? '已配置' : '可选，转码回写后自动使用 HLS URL' }}</strong></div><div class="connection-check"><span>Stream Webhook</span><strong :class="data?.cloudflare.streamWebhookConfigured ? 'success-text' : 'danger-text'">{{ data?.cloudflare.streamWebhookConfigured ? 'Secret 与回调地址均匹配' : data?.cloudflare.streamWebhookError || '待配置回调验签' }}</strong></div><div class="connection-copy"><code>{{ data?.cloudflare.streamWebhookUrl || 'https://iseedrama.com/api/media/stream-webhook' }}</code><button type="button" title="复制 Stream Webhook URL" @click="copyValue(data?.cloudflare.streamWebhookUrl || '')"><Copy :size="15" /></button></div><div class="connection-check"><span>自定义域名与证书</span><strong>{{ customHostnamesStatusText }}</strong></div><div class="connection-check"><span>播放跟踪签名</span><strong>{{ data?.cloudflare.mediaSigningConfigured ? '已加密配置' : '待配置' }}</strong></div></section>
      <section class="admin-panel connection-panel"><div class="admin-panel__header"><div><h2>上线步骤</h2><p>按当前开通进度继续配置</p></div></div><ol class="deployment-steps"><li><span>1</span><div><strong>确认 D1 已执行全部迁移</strong><code>npm run db:migrate -- --apply</code></div></li><li><span>2</span><div><strong>创建 R2 与媒体 Worker</strong><small>配置 R2 binding、Stream API 和签名密钥</small></div></li><li><span>3</span><div><strong>配置 PayPal 两套环境 Secrets</strong><small>服务端和浏览器 Client ID 必须一致</small></div></li><li><span>4</span><div><strong>启用 Custom Hostnames 与 Webhook</strong><small>完成后在本页重新检测</small></div></li></ol><a class="el-button" href="https://dash.cloudflare.com/" target="_blank" rel="noreferrer">打开 Cloudflare<ExternalLink :size="15" /></a></section>
    </div>
    <section v-if="data?.paypal.failedWebhooks.length" class="admin-panel admin-table-panel"><div class="admin-panel__header"><div><h2>失败的 PayPal Webhook</h2><p>仅可重放已通过 PayPal 签名验证且保存了最小化载荷的事件。</p></div></div><el-table :data="data.paypal.failedWebhooks" row-key="eventId"><el-table-column prop="eventType" label="事件类型" min-width="220" /><el-table-column prop="eventId" label="Event ID" min-width="180" /><el-table-column label="失败原因" min-width="220"><template #default="scope">{{ scope.row.errorMessage || '未知错误' }}</template></el-table-column><el-table-column label="重试" width="80"><template #default="scope">{{ scope.row.retryCount }}</template></el-table-column><el-table-column label="接收时间" min-width="170"><template #default="scope">{{ new Date(scope.row.receivedAt).toLocaleString('zh-CN', { hour12: false }) }}</template></el-table-column><el-table-column label="操作" width="110"><template #default="scope"><el-button type="primary" link :disabled="!scope.row.replayable" :loading="retryingWebhook === scope.row.eventId" @click="retryWebhook(scope.row.eventId)"><RefreshCw :size="15" />重试</el-button></template></el-table-column></el-table></section>
  </div>
</template>
