import type { AdminSession } from '~/types/admin';
import type { ApiEnvelope } from '~/types/content';

export const useAdminAuth = () => {
  const baseURL = useRuntimeConfig().public.apiBase;
  const session = useState<AdminSession | null>('admin-session', () => null);
  const sessionChecked = useState('admin-session-checked', () => false);

  const isAuthenticated = computed(() => Boolean(session.value?.id));
  const isSuperAdmin = computed(() => session.value?.role === 'super_admin');
  const user = computed(() => session.value || {
    id: '',
    email: '',
    name: '管理员',
    role: 'admin' as const,
    loggedInAt: '',
    expiresAt: '',
  });

  const fetchSession = async (force = false) => {
    if (sessionChecked.value && !force) return session.value;
    try {
      const response = await $fetch<ApiEnvelope<AdminSession>>('/admin/auth/session', { baseURL, credentials: 'include' });
      session.value = response.data;
    } catch {
      session.value = null;
    } finally {
      sessionChecked.value = true;
    }
    return session.value;
  };

  const login = async (details: { email: string; password: string; remember: boolean }) => {
    const response = await $fetch<ApiEnvelope<AdminSession>>('/admin/auth/login', {
      baseURL,
      credentials: 'include',
      method: 'POST',
      body: details,
    });
    session.value = response.data;
    sessionChecked.value = true;
    return response.data;
  };

  const logout = async () => {
    try {
      await $fetch('/admin/auth/logout', { baseURL, credentials: 'include', method: 'POST' });
    } finally {
      session.value = null;
      sessionChecked.value = true;
    }
  };

  return { session, user, isAuthenticated, isSuperAdmin, fetchSession, login, logout };
};
