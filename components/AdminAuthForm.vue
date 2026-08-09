<script setup lang="ts">
import {
  Check,
  ChevronRight,
  Clapperboard,
  Eye,
  EyeOff,
  KeyRound,
  LockKeyhole,
  Mail,
  ShieldCheck,
  UserRound,
} from 'lucide-vue-next';
import { ElMessage } from 'element-plus';

const props = defineProps<{ mode: 'login' | 'register' }>();
const form = reactive({ name: '', email: '', password: '', remember: true, agreement: false });
const errors = reactive({ name: '', email: '', password: '', agreement: '' });
const showPassword = ref(false);
const submitting = ref(false);
const isLogin = computed(() => props.mode === 'login');

const clearErrors = () => {
  errors.name = ''; errors.email = ''; errors.password = ''; errors.agreement = '';
};

const validate = () => {
  clearErrors();
  if (!isLogin.value && !form.name.trim()) errors.name = '请输入管理员姓名';
  if (!form.email.trim()) errors.email = '请输入邮箱地址';
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) errors.email = '请输入有效的邮箱地址';
  if (!form.password) errors.password = '请输入密码';
  else if (form.password.length < 8) errors.password = '密码至少需要 8 位';
  if (!isLogin.value && !form.agreement) errors.agreement = '请先同意服务条款与隐私政策';
  return !Object.values(errors).some(Boolean);
};

const submit = async () => {
  if (!validate()) return;
  submitting.value = true;
  await new Promise((resolve) => setTimeout(resolve, 650));
  ElMessage.success(isLogin.value ? '登录成功' : '管理员账号已创建');
  await navigateTo('/admin');
  submitting.value = false;
};
</script>

<template>
  <main class="admin-auth">
    <section class="admin-auth__visual" aria-label="ReelNova 内容运营平台">
      <div class="admin-auth__brand"><span><Clapperboard :size="20" /></span><div><strong>ReelNova</strong><small>ADMIN CONSOLE</small></div></div>
      <div class="admin-auth__visual-copy"><span class="admin-auth__eyebrow"><i /> CONTENT OPERATIONS</span><h1>让每一部短剧<br>找到它的观众</h1><p>从内容发布到订单转化，在一个工作台完成全球短剧业务管理。</p></div>
      <div class="admin-auth__pulse"><span><i />平台运行正常</span><strong>GLOBAL · 24/7</strong></div>
    </section>

    <section class="admin-auth__form-side">
      <div class="admin-auth__mobile-brand"><span><Clapperboard :size="18" /></span><strong>ReelNova Admin</strong></div>
      <div class="admin-auth__form-wrap">
        <div class="admin-auth__heading"><span>{{ isLogin ? 'WELCOME BACK' : 'CREATE ACCOUNT' }}</span><h2>{{ isLogin ? '登录后台' : '注册管理员' }}</h2><p>{{ isLogin ? '使用管理员账号继续进入工作台。' : '创建账号，开始管理内容与业务数据。' }}</p></div>
        <nav class="admin-auth__switch" aria-label="登录或注册"><NuxtLink to="/admin/login" :class="{ 'is-active': isLogin }">登录</NuxtLink><NuxtLink to="/admin/register" :class="{ 'is-active': !isLogin }">注册</NuxtLink></nav>

        <form class="admin-auth__form" novalidate @submit.prevent="submit">
          <label v-if="!isLogin" class="admin-auth__field"><span>管理员姓名</span><div :class="{ 'has-error': errors.name }"><UserRound :size="17" /><input v-model="form.name" autocomplete="name" placeholder="例如：Alex Chen" @input="errors.name = ''"></div><small v-if="errors.name">{{ errors.name }}</small></label>
          <label class="admin-auth__field"><span>邮箱地址</span><div :class="{ 'has-error': errors.email }"><Mail :size="17" /><input v-model="form.email" type="email" autocomplete="email" placeholder="admin@reelnova.com" @input="errors.email = ''"></div><small v-if="errors.email">{{ errors.email }}</small></label>
          <label class="admin-auth__field"><span>密码</span><div :class="{ 'has-error': errors.password }"><LockKeyhole :size="17" /><input v-model="form.password" :type="showPassword ? 'text' : 'password'" :autocomplete="isLogin ? 'current-password' : 'new-password'" placeholder="至少 8 位字符" @input="errors.password = ''"><button type="button" :aria-label="showPassword ? '隐藏密码' : '显示密码'" @click="showPassword = !showPassword"><EyeOff v-if="showPassword" :size="17" /><Eye v-else :size="17" /></button></div><small v-if="errors.password">{{ errors.password }}</small></label>

          <div v-if="isLogin" class="admin-auth__options"><label class="admin-auth__checkbox"><input v-model="form.remember" type="checkbox"><span><Check :size="12" /></span>记住登录状态</label><button type="button" @click="ElMessage.info('请联系超级管理员重置密码')">忘记密码？</button></div>
          <div v-else class="admin-auth__agreement"><label class="admin-auth__checkbox"><input v-model="form.agreement" type="checkbox" @change="errors.agreement = ''"><span><Check :size="12" /></span>我已阅读并同意服务条款与隐私政策</label><small v-if="errors.agreement">{{ errors.agreement }}</small></div>

          <button class="admin-auth__submit" type="submit" :disabled="submitting"><KeyRound v-if="isLogin" :size="17" /><UserRound v-else :size="17" />{{ submitting ? '正在处理...' : (isLogin ? '登录工作台' : '创建管理员账号') }}<ChevronRight v-if="!submitting" :size="17" /></button>
        </form>
        <div class="admin-auth__security"><ShieldCheck :size="17" /><p><strong>安全登录</strong><span>会话与敏感操作均记录审计日志</span></p></div>
      </div>
      <p class="admin-auth__copyright">© 2026 ReelNova · Global content operations</p>
    </section>
  </main>
</template>
