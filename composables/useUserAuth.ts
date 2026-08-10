import type { ApiEnvelope } from '~/types/content';
import type { UserLoginInput, UserRegisterInput, UserSession } from '~/types/user';

export const useUserAuth = () => {
  const session = useState<UserSession | null>('user-session', () => null);
  const sessionChecked = useState('user-session-checked', () => false);
  const isAuthenticated = computed(() => Boolean(session.value?.userId));

  const fetchSession = async (force = false) => {
    if (sessionChecked.value && !force) return session.value;
    try {
      const response = await $fetch<ApiEnvelope<UserSession>>('/api/auth/session', {
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
    const response = await $fetch<ApiEnvelope<UserSession>>('/api/auth/login', { method: 'POST', body: input });
    session.value = response.data;
    sessionChecked.value = true;
    return response.data;
  };

  const register = async (input: UserRegisterInput) => {
    const response = await $fetch<ApiEnvelope<UserSession>>('/api/auth/register', { method: 'POST', body: input });
    session.value = response.data;
    sessionChecked.value = true;
    return response.data;
  };

  const logout = async () => {
    try {
      await $fetch('/api/auth/logout', { method: 'POST' });
    } finally {
      session.value = null;
      sessionChecked.value = true;
    }
  };

  return { session, sessionChecked, isAuthenticated, fetchSession, login, register, logout };
};
