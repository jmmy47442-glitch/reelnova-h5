import type { ApiEnvelope } from '~/types/content';
import type { UserLoginInput, UserPasswordResetInput, UserRegisterInput, UserSession } from '~/types/user';
import { useAccountSettings } from '~/composables/useAccountSettings';
import { clearPageDataCache } from '~/composables/usePageData';
import {
  createUserPasswordSalt,
  deriveUserPasswordHash,
  deriveUserPasswordProof,
} from '~/shared/user-password-proof';

export const useUserAuth = () => {
  const baseURL = useRuntimeConfig().public.apiBase;
  const requestFetch = useRequestFetch();
  const accountSettings = useAccountSettings();
  const session = useState<UserSession | null>('user-session', () => null);
  const sessionChecked = useState('user-session-checked', () => false);
  const isAuthenticated = computed(() => Boolean(session.value?.userId));

  const fetchSession = async (force = false) => {
    if (sessionChecked.value && !force) return session.value;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await requestFetch<ApiEnvelope<UserSession>>('/auth/session', { baseURL, credentials: 'include' });
        session.value = response.data;
        sessionChecked.value = true;
        return session.value;
      } catch (error: unknown) {
        const statusCode = (error as { statusCode?: number; response?: { status?: number } }).statusCode
          || (error as { response?: { status?: number } }).response?.status;
        if (statusCode === 401 || statusCode === 403) {
          session.value = null;
          sessionChecked.value = true;
          return session.value;
        }
        if (attempt === 0) continue;
        sessionChecked.value = false;
        throw error;
      }
    }
    return null;
  };

  const login = async (input: UserLoginInput) => {
    const challengeResponse = await $fetch<ApiEnvelope<{ challenge: string; salt: string; iterations: number }>>('/auth/challenge', {
      baseURL,
      method: 'POST',
      body: { email: input.email },
    });
    const { challenge, salt, iterations } = challengeResponse.data;
    const proof = await deriveUserPasswordProof(input.password, salt, challenge, iterations);
    const response = await $fetch<ApiEnvelope<UserSession>>('/auth/login', {
      baseURL,
      credentials: 'include',
      method: 'POST',
      body: { email: input.email, challenge, proof, remember: input.remember },
    });
    session.value = response.data;
    sessionChecked.value = true;
    return response.data;
  };

  const register = async (input: UserRegisterInput) => {
    const passwordSalt = createUserPasswordSalt();
    const passwordHash = await deriveUserPasswordHash(input.password, passwordSalt);
    const response = await $fetch<ApiEnvelope<UserSession>>('/auth/register', {
      baseURL,
      credentials: 'include',
      method: 'POST',
      body: { ...input, passwordSalt, passwordHash },
    });
    session.value = response.data;
    sessionChecked.value = true;
    return response.data;
  };

  const resetPassword = async (input: UserPasswordResetInput) => {
    const passwordSalt = createUserPasswordSalt();
    const passwordHash = await deriveUserPasswordHash(input.password, passwordSalt);
    const challengeResponse = await $fetch<ApiEnvelope<{ challenge: string }>>('/auth/challenge', {
      baseURL,
      method: 'POST',
      body: { email: input.email, purpose: 'reset' },
    });
    const proof = await deriveUserPasswordProof(input.password, passwordSalt, challengeResponse.data.challenge);
    const response = await $fetch<ApiEnvelope<{ email: string }>>('/auth/password-reset', {
      baseURL,
      credentials: 'include',
      method: 'POST',
      body: { ...input, passwordSalt, passwordHash, challenge: challengeResponse.data.challenge, proof },
    });
    return response.data;
  };

  const logout = async () => {
    try {
      await $fetch('/auth/logout', { baseURL, credentials: 'include', method: 'POST' });
    } finally {
      session.value = null;
      sessionChecked.value = true;
      accountSettings.resetSettings();
      clearPageDataCache();
    }
  };

  return { session, sessionChecked, isAuthenticated, fetchSession, login, register, resetPassword, logout };
};
