import type { AdminSession } from '~/types/admin';
import type { ApiEnvelope } from '~/types/content';
import type { AdminPermission } from '~/shared/admin-rbac';
import { adminRoleLabels, getAdminLandingPath, hasAdminPermission } from '~/shared/admin-rbac';
import { deriveAdminPasswordProof } from '~/shared/admin-password-proof';

export const useAdminAuth = () => {
  const baseURL = useRuntimeConfig().public.apiBase;
  const session = useState<AdminSession | null>('admin-session', () => null);
  const sessionChecked = useState('admin-session-checked', () => false);

  const isAuthenticated = computed(() => Boolean(session.value?.id));
  const isSuperAdmin = computed(() => session.value?.role === 'super_admin');
  const roleLabel = computed(() => session.value ? adminRoleLabels[session.value.role] : '管理员');
  const landingPath = computed(() => getAdminLandingPath(session.value?.role));
  const can = (permission: AdminPermission) => hasAdminPermission(session.value?.role, permission);
  const user = computed(() => session.value || {
    id: '',
    email: '',
    name: '管理员',
    role: 'content_operator' as const,
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
    const challengeResponse = await $fetch<ApiEnvelope<{ challenge: string; salt: string; iterations: number }>>('/admin/auth/challenge', {
      baseURL,
      method: 'POST',
      body: { email: details.email },
    });
    const { challenge, salt, iterations } = challengeResponse.data;
    const proof = await deriveAdminPasswordProof(details.password, salt, challenge, iterations);
    const response = await $fetch<ApiEnvelope<AdminSession>>('/admin/auth/login', {
      baseURL,
      credentials: 'include',
      method: 'POST',
      body: { email: details.email, challenge, proof, remember: details.remember },
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

  return { session, user, isAuthenticated, isSuperAdmin, roleLabel, landingPath, can, fetchSession, login, logout };
};
