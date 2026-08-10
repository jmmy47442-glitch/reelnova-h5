<script setup lang="ts">
import {
  Check,
  ChevronRight,
  Eye,
  EyeOff,
  LockKeyhole,
  Mail,
  ShieldCheck,
  Sparkles,
  UserRound,
} from 'lucide-vue-next';
import { useUserAuth } from '~/composables/useUserAuth';

const props = defineProps<{ mode: 'login' | 'register' }>();
const route = useRoute();
const { login, register } = useUserAuth();
const form = reactive({ name: '', email: '', password: '', confirmPassword: '', remember: true, agreement: false });
const errors = reactive({ name: '', email: '', password: '', confirmPassword: '', agreement: '', submit: '' });
const showPassword = ref(false);
const submitting = ref(false);

const isRegister = computed(() => props.mode === 'register');
const redirect = computed(() => typeof route.query.redirect === 'string'
  && route.query.redirect.startsWith('/')
  && !route.query.redirect.startsWith('/admin')
  ? route.query.redirect
  : '/');
const alternateTo = computed(() => ({
  path: isRegister.value ? '/login' : '/register',
  query: route.query.redirect ? { redirect: route.query.redirect } : undefined,
}));

const clearErrors = () => {
  Object.keys(errors).forEach(key => { errors[key as keyof typeof errors] = ''; });
};

watch(() => props.mode, clearErrors);

const validate = () => {
  clearErrors();
  if (isRegister.value && (form.name.trim().length < 2 || form.name.trim().length > 40)) errors.name = 'Enter a name between 2 and 40 characters.';
  if (!form.email.trim()) errors.email = 'Enter your email address.';
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) errors.email = 'Enter a valid email address.';
  if (!form.password) errors.password = 'Enter your password.';
  else if (form.password.length < 8) errors.password = 'Use at least 8 characters.';
  else if (isRegister.value && (!/[A-Za-z]/.test(form.password) || !/\d/.test(form.password))) errors.password = 'Include at least one letter and one number.';
  if (isRegister.value && form.confirmPassword !== form.password) errors.confirmPassword = 'Passwords do not match.';
  if (isRegister.value && !form.agreement) errors.agreement = 'Accept the terms to create your account.';
  return !Object.values(errors).some(Boolean);
};

const submit = async () => {
  if (!validate()) return;
  submitting.value = true;
  try {
    const credentials = { email: form.email.trim().toLowerCase(), password: form.password, remember: form.remember };
    if (isRegister.value) await register({ ...credentials, name: form.name.trim() });
    else await login(credentials);
    await navigateTo(redirect.value);
  } catch (error: unknown) {
    const statusCode = (error as { statusCode?: number; response?: { status?: number } }).statusCode
      || (error as { response?: { status?: number } }).response?.status;
    errors.submit = statusCode === 401
      ? 'That email and password combination was not found.'
      : statusCode === 409
        ? 'An account with this email or browser is already linked. Sign in instead, or sign out before creating another account.'
        : statusCode === 503
          ? 'Account service is temporarily unavailable. Try again shortly.'
          : 'We could not complete your request. Try again.';
  } finally {
    submitting.value = false;
  }
};
</script>

<template>
  <main class="consumer-auth" :class="`consumer-auth--${mode}`">
    <section class="consumer-auth__visual" aria-label="ReelNova original short dramas">
      <NuxtLink class="consumer-auth__brand" to="/login" aria-label="ReelNova">
        <span>R</span><strong>REELNOVA</strong>
      </NuxtLink>
      <div class="consumer-auth__story">
        <span class="consumer-auth__eyebrow"><Sparkles :size="14" /> ORIGINAL SHORT DRAMA</span>
        <h1>One more episode.<br><em>One less excuse.</em></h1>
        <p>Fast stories, impossible choices, and a new ending waiting every night.</p>
      </div>
      <div class="consumer-auth__rail" aria-hidden="true">
        <span>01</span><i /><span class="is-active">02</span><i /><span>03</span><i /><span>04</span>
      </div>
      <div class="consumer-auth__premiere"><span><i /> NOW PREMIERING</span><strong>VOWS &amp; VENGEANCE</strong></div>
    </section>

    <section class="consumer-auth__panel">
      <div class="consumer-auth__mobile-brand"><span>R</span><strong>REELNOVA</strong></div>
      <div class="consumer-auth__form-wrap">
        <header class="consumer-auth__heading">
          <span>{{ isRegister ? 'START YOUR STORY' : 'WELCOME BACK' }}</span>
          <h2>{{ isRegister ? 'Create your account' : 'Sign in to watch' }}</h2>
          <p>{{ isRegister ? 'Keep purchases and watch progress connected.' : 'Pick up from the exact moment you left.' }}</p>
        </header>

        <nav class="consumer-auth__switch" aria-label="Account access">
          <NuxtLink :to="{ path: '/login', query: route.query.redirect ? { redirect: route.query.redirect } : undefined }" :class="{ 'is-active': !isRegister }">Sign in</NuxtLink>
          <NuxtLink :to="{ path: '/register', query: route.query.redirect ? { redirect: route.query.redirect } : undefined }" :class="{ 'is-active': isRegister }">Register</NuxtLink>
        </nav>

        <form class="consumer-auth__form" novalidate @submit.prevent="submit">
          <label v-if="isRegister" class="consumer-auth__field">
            <span>Name</span>
            <div :class="{ 'has-error': errors.name }"><UserRound :size="18" /><input v-model="form.name" type="text" autocomplete="name" placeholder="Your name" @input="errors.name = ''; errors.submit = ''"></div>
            <small v-if="errors.name">{{ errors.name }}</small>
          </label>
          <label class="consumer-auth__field">
            <span>Email</span>
            <div :class="{ 'has-error': errors.email }"><Mail :size="18" /><input v-model="form.email" type="email" autocomplete="email" placeholder="you@example.com" @input="errors.email = ''; errors.submit = ''"></div>
            <small v-if="errors.email">{{ errors.email }}</small>
          </label>
          <label class="consumer-auth__field">
            <span>Password</span>
            <div :class="{ 'has-error': errors.password }"><LockKeyhole :size="18" /><input v-model="form.password" :type="showPassword ? 'text' : 'password'" :autocomplete="isRegister ? 'new-password' : 'current-password'" placeholder="At least 8 characters" @input="errors.password = ''; errors.submit = ''"><button type="button" :aria-label="showPassword ? 'Hide password' : 'Show password'" @click="showPassword = !showPassword"><EyeOff v-if="showPassword" :size="18" /><Eye v-else :size="18" /></button></div>
            <small v-if="errors.password">{{ errors.password }}</small>
          </label>
          <label v-if="isRegister" class="consumer-auth__field">
            <span>Confirm password</span>
            <div :class="{ 'has-error': errors.confirmPassword }"><ShieldCheck :size="18" /><input v-model="form.confirmPassword" :type="showPassword ? 'text' : 'password'" autocomplete="new-password" placeholder="Enter it again" @input="errors.confirmPassword = ''; errors.submit = ''"></div>
            <small v-if="errors.confirmPassword">{{ errors.confirmPassword }}</small>
          </label>

          <div v-if="!isRegister" class="consumer-auth__options">
            <label class="consumer-auth__checkbox"><input v-model="form.remember" type="checkbox"><span><Check :size="12" /></span>Keep me signed in</label>
            <a href="mailto:support@reelnova.com">Forgot password?</a>
          </div>
          <label v-else class="consumer-auth__checkbox consumer-auth__terms"><input v-model="form.agreement" type="checkbox" @change="errors.agreement = ''"><span><Check :size="12" /></span><em>I agree to the Terms and Privacy Policy.</em></label>
          <small v-if="errors.agreement" class="consumer-auth__inline-error">{{ errors.agreement }}</small>
          <p v-if="errors.submit" class="consumer-auth__submit-error" role="alert">{{ errors.submit }}</p>
          <button class="consumer-auth__submit" type="submit" :disabled="submitting">
            {{ submitting ? 'Please wait...' : isRegister ? 'Create account' : 'Sign in' }}
            <ChevronRight v-if="!submitting" :size="18" />
          </button>
        </form>

        <p class="consumer-auth__alternate">{{ isRegister ? 'Already have an account?' : 'New to ReelNova?' }} <NuxtLink :to="alternateTo">{{ isRegister ? 'Sign in' : 'Register' }}</NuxtLink></p>
      </div>
      <p class="consumer-auth__legal">By continuing, you confirm you are 18 or older.</p>
    </section>
  </main>
</template>
