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
  UserCog,
} from 'lucide-vue-next';
import { ElMessage } from 'element-plus';

const route = useRoute();
const { login } = useAdminAuth();
const form = reactive({ email: '', password: '', remember: true });
const errors = reactive({ email: '', password: '', submit: '' });
const showPassword = ref(false);
const submitting = ref(false);

const validate = () => {
  errors.email = '';
  errors.password = '';
  errors.submit = '';
  if (!form.email.trim()) errors.email = '请输入邮箱地址';
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) errors.email = '请输入有效的邮箱地址';
  if (!form.password) errors.password = '请输入密码';
  else if (form.password.length < 8) errors.password = '密码至少需要 8 位';
  return !errors.email && !errors.password;
};

const submit = async () => {
  if (!validate()) return;
  submitting.value = true;
  try {
    await login({ email: form.email.trim().toLowerCase(), password: form.password, remember: form.remember });
    ElMessage.success('登录成功');
    const redirect = typeof route.query.redirect === 'string' && route.query.redirect.startsWith('/admin')
      ? route.query.redirect
      : '/admin';
    await navigateTo(redirect);
  } catch (error: unknown) {
    const statusCode = (error as { statusCode?: number; response?: { status?: number } }).statusCode
      || (error as { response?: { status?: number } }).response?.status;
    errors.submit = statusCode === 401
      ? '邮箱或密码错误，或账号已被停用'
      : statusCode === 503
        ? '管理员数据库尚未配置，请联系系统维护人员'
        : '登录失败，请稍后重试';
  } finally {
    submitting.value = false;
  }
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
        <div class="admin-auth__heading"><span>AUTHORIZED ACCESS</span><h2>登录后台</h2><p>使用已开通的管理员账号进入工作台。</p></div>
        <div class="admin-auth__access-note"><UserCog :size="17" /><span>管理员账号由超级管理员统一创建</span></div>

        <form class="admin-auth__form" novalidate @submit.prevent="submit">
          <label class="admin-auth__field"><span>邮箱地址</span><div :class="{ 'has-error': errors.email }"><Mail :size="17" /><input v-model="form.email" type="email" autocomplete="email" placeholder="admin@reelnova.com" @input="errors.email = ''; errors.submit = ''"></div><small v-if="errors.email">{{ errors.email }}</small></label>
          <label class="admin-auth__field"><span>密码</span><div :class="{ 'has-error': errors.password }"><LockKeyhole :size="17" /><input v-model="form.password" :type="showPassword ? 'text' : 'password'" autocomplete="current-password" placeholder="输入管理员密码" @input="errors.password = ''; errors.submit = ''"><button type="button" :aria-label="showPassword ? '隐藏密码' : '显示密码'" @click="showPassword = !showPassword"><EyeOff v-if="showPassword" :size="17" /><Eye v-else :size="17" /></button></div><small v-if="errors.password">{{ errors.password }}</small></label>

          <div class="admin-auth__options"><label class="admin-auth__checkbox"><input v-model="form.remember" type="checkbox"><span><Check :size="12" /></span>7 天内保持登录</label><button type="button" @click="ElMessage.info('请联系超级管理员重置密码')">忘记密码？</button></div>
          <p v-if="errors.submit" class="admin-auth__submit-error" role="alert">{{ errors.submit }}</p>
          <button class="admin-auth__submit" type="submit" :disabled="submitting"><KeyRound :size="17" />{{ submitting ? '正在验证...' : '登录工作台' }}<ChevronRight v-if="!submitting" :size="17" /></button>
        </form>
        <div class="admin-auth__security"><ShieldCheck :size="17" /><p><strong>安全登录</strong><span>会话与敏感操作均记录审计日志</span></p></div>
      </div>
      <p class="admin-auth__copyright">© 2026 ReelNova · Global content operations</p>
    </section>
  </main>
</template>
