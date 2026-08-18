import type { ApiEnvelope } from '~/types/content';
import type { UserLoginInput, UserPasswordResetInput, UserRegisterInput, UserSession } from '~/types/user';
import { useAccountSettings } from '~/composables/useAccountSettings';

export const useUserAuth = () => {
  const baseURL = useRuntimeConfig().public.apiBase;
  const accountSettings = useAccountSettings();
  const session = useState<UserSession | null>('user-session', () => null);
  const sessionChecked = useState('user-session-checked', () => false);
  const isAuthenticated = computed(() => Boolean(session.value?.userId));

  const fetchSession = async (force = false) => {
    if (sessionChecked.value && !force) return session.value;
    try {
      const response = await $fetch<ApiEnvelope<UserSession>>('/auth/session', {
        baseURL,
        credentials: 'include',
        headers: import.meta.server ? useRequestHeaders(['cookie']) : undefined,
      });
      session.value = response.data;
    } catch {
      session.value = null;
    } finally {
      sessionChecked.value = true;
    }
    return session.value;
  };

  const login = async (input: UserLoginInput) => {
    const response = await $fetch<ApiEnvelope<UserSession>>('/auth/login', { baseURL, credentials: 'include', method: 'POST', body: input });
    session.value = response.data;
    sessionChecked.value = true;
    return response.data;
  };

  const register = async (input: UserRegisterInput) => {
    const response = await $fetch<ApiEnvelope<UserSession>>('/auth/register', { baseURL, credentials: 'include', method: 'POST', body: input });
    session.value = response.data;
    sessionChecked.value = true;
    return response.data;
  };

  const resetPassword = async (input: UserPasswordResetInput) => {
    const response = await $fetch<ApiEnvelope<{ email: string }>>('/auth/password-reset', { baseURL, credentials: 'include', method: 'POST', body: input });
    return response.data;
  };

  const logout = async () => {
    try {
      await $fetch('/auth/logout', { baseURL, credentials: 'include', method: 'POST' });
    } finally {
      session.value = null;
      sessionChecked.value = true;
      accountSettings.resetSettings();
    }
  };

  return { session, sessionChecked, isAuthenticated, fetchSession, login, register, resetPassword, logout };
};
