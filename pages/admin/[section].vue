<script setup lang="ts">
import { ArrowLeft, Construction } from 'lucide-vue-next';

definePageMeta({ layout: 'admin' });
const route = useRoute();
const names: Record<string, [string, string]> = {
  taxonomy: ['分类与标签', '管理内容分类、多语言名称、标签颜色与有效期。'],
  users: ['用户与权益', '查询注册用户、购买权益、观看记录和设备限制。'],
  reconciliation: ['对账中心', '按日期和币种汇总收入、退款与异常订单。'],
  domains: ['域名管理', '管理主备域名、HTTPS 证书和跳转策略。'],
  audit: ['审计日志', '追踪高风险操作的变更前后值、操作人和 IP。'],
};
const page = computed(() => names[String(route.params.section)] || ['管理页面', '该模块已预留路由和接口位置。']);
</script>

<template>
  <div><AdminPageHeader :title="page[0]" :description="page[1]" /><section class="admin-panel admin-placeholder"><span><Construction :size="28" /></span><h2>模块接口已预留</h2><p>页面将使用 Art Design Pro 的查询表格与抽屉表单模式，后端端点见接口对接文档。</p><NuxtLink to="/admin" class="el-button"><ArrowLeft :size="16" />返回数据概览</NuxtLink></section></div>
</template>
