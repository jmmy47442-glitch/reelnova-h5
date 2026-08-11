import type { ApiEnvelope } from '~/types/content';
import type { AccountDataExport, AccountSettings } from '~/types/user';

const defaults = (): AccountSettings => ({
  language: 'en', recommendations: true, analytics: true, marketing: false, updatedAt: null,
});

export const useAccountSettings = () => {
  const baseURL = useRuntimeConfig().public.apiBase;
  const settings = useState<AccountSettings>('account-settings', defaults);
  const settingsChecked = useState('account-settings-checked', () => false);
  const request = <T>(path: string, options: Parameters<typeof $fetch>[1] = {}) =>
    $fetch<ApiEnvelope<T>>(path, { baseURL, credentials: 'include', ...options }).then((response) => response.data);

  const fetchSettings = async (force = false) => {
    if (settingsChecked.value && !force) return settings.value;
    try {
      settings.value = await request<AccountSettings>('/me/settings', {
        headers: import.meta.server ? useRequestHeaders(['cookie']) : undefined,
      });
      if (import.meta.client) document.documentElement.lang = settings.value.language;
    } finally {
      settingsChecked.value = true;
    }
    return settings.value;
  };
  const updateSettings = async (input: Partial<AccountSettings>) => {
    settings.value = await request<AccountSettings>('/me/settings', { method: 'PATCH', body: input });
    if (import.meta.client) document.documentElement.lang = settings.value.language;
    return settings.value;
  };
  const exportData = () => request<AccountDataExport>('/me/data-export', { method: 'POST' });
  const deleteAccount = (email: string, confirmation: string) => request<{ requestId: string; deletedAt: string }>(
    '/me/account', { method: 'DELETE', body: { email, confirmation } },
  );
  const resetSettings = () => {
    settings.value = defaults();
    settingsChecked.value = false;
    if (import.meta.client) document.documentElement.lang = 'en';
  };
  return { settings, settingsChecked, fetchSettings, updateSettings, exportData, deleteAccount, resetSettings };
};
