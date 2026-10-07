import type { AdminSession } from '~/types/admin';
import type { ApiEnvelope } from '~/types/content';
import type { AdminPermission } from '~/shared/admin-rbac';
import { adminRoleLabels, getAdminLandingPath, hasAdminPermission } from '~/shared/admin-rbac';
import { deriveAdminPasswordProof } from '~/shared/admin-password-proof';

// Several rapid menu clicks can enter the global route middleware before the
// first session request finishes. Share that in-flight request on the client
// so navigation cannot create a queue of identical /admin/auth/session calls.
let pendingSessionRequest: Promise<AdminSession | null> | undefined;

export const useAdminAuth = () => {
  const baseURL = useRuntimeConfig().public.apiBase;
  const session = useState<AdminSession | null>('admin-session', () => null);
  const sessionChecked = useState('admin-session-checked', () => false);
  const sessionCheckedAt = useState<number>('admin-session-checked-at', () => 0);
  const sessionCacheTtl = 60_000;

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
    if (sessionChecked.value && !force && Date.now() - sessionCheckedAt.value < sessionCacheTtl) return session.value;
    if (import.meta.client && pendingSessionRequest) return pendingSessionRequest;

    const request = (async () => {
      try {
        const response = await $fetch<ApiEnvelope<AdminSession>>('/admin/auth/session', { baseURL, credentials: 'include' });
        session.value = response.data;
      } catch {
        session.value = null;
      } finally {
        sessionChecked.value = true;
        sessionCheckedAt.value = Date.now();
      }
      return session.value;
    })();
    if (import.meta.client) pendingSessionRequest = request;
    try {
      return await request;
    } finally {
      if (import.meta.client && pendingSessionRequest === request) pendingSessionRequest = undefined;
    }
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
    sessionCheckedAt.value = Date.now();
    return response.data;
  };

  const logout = async () => {
    try {
      await $fetch('/admin/auth/logout', { baseURL, credentials: 'include', method: 'POST' });
    } finally {
      session.value = null;
      sessionChecked.value = true;
      sessionCheckedAt.value = Date.now();
    }
  };

  return { session, user, isAuthenticated, isSuperAdmin, roleLabel, landingPath, can, fetchSession, login, logout };
};
