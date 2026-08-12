import type { H3Event } from 'h3';
import type { DomainConfig, DomainValidationRecord } from '~/types/admin';
import { getSystemConfig, saveSystemConfig } from './system-config';

interface CloudflareError { code?: number; message?: string }
interface CloudflareEnvelope<T> { success: boolean; result: T; errors?: CloudflareError[] }
interface CloudflareValidationRecord { status?: string; txt_name?: string; txt_value?: string }
interface CloudflareCustomHostname {
  id: string;
  hostname: string;
  status: string;
  verification_errors?: string[];
  ssl?: {
    status?: string;
    validation_errors?: Array<{ message?: string }>;
    validation_records?: CloudflareValidationRecord[];
  };
}

export type DomainAutomationMissingField = 'zoneId' | 'apiToken' | 'cnameTarget';

export interface DomainAutomationSettings {
  zoneId: string;
  cnameTarget: string;
}

export interface DomainAutomationStatus extends DomainAutomationSettings {
  apiTokenConfigured: boolean;
  automationConfigured: boolean;
  missingFields: DomainAutomationMissingField[];
}

const settingsId = 'domain-automation';

const normalizeHostname = (value: unknown) => String(value || '').trim().toLowerCase().replace(/\.$/, '');

export const getCloudflareDomainAutomationStatus = async (event: H3Event): Promise<DomainAutomationStatus> => {
  const runtime = useRuntimeConfig(event);
  const saved = await getSystemConfig<DomainAutomationSettings>(event, settingsId, { zoneId: '', cnameTarget: '' });
  const zoneId = String(saved.zoneId || runtime.cloudflareZoneId || '').trim();
  const cnameTarget = normalizeHostname(saved.cnameTarget || runtime.domainCnameTarget);
  const apiTokenConfigured = Boolean(String(runtime.cloudflareApiToken || '').trim());
  const missingFields: DomainAutomationMissingField[] = [];
  if (!zoneId) missingFields.push('zoneId');
  if (!apiTokenConfigured) missingFields.push('apiToken');
  if (!cnameTarget) missingFields.push('cnameTarget');
  return { zoneId, cnameTarget, apiTokenConfigured, missingFields, automationConfigured: missingFields.length === 0 };
};

export const saveCloudflareDomainAutomationSettings = async (event: H3Event, settings: DomainAutomationSettings) => {
  await saveSystemConfig(event, settingsId, {
    zoneId: settings.zoneId.trim(),
    cnameTarget: normalizeHostname(settings.cnameTarget),
  });
};

const cloudflareRequest = async <T>(event: H3Event, path: string, options: Parameters<typeof $fetch>[1] = {}) => {
  const config = useRuntimeConfig(event);
  const { zoneId } = await getCloudflareDomainAutomationStatus(event);
  const apiToken = String(config.cloudflareApiToken || '').trim();
  if (!zoneId || !apiToken) throw createError({
    statusCode: 503,
    statusMessage: 'CLOUDFLARE_ZONE_ID and CLOUDFLARE_API_TOKEN are required for domain automation',
  });
  try {
    const response = await $fetch<CloudflareEnvelope<T>>(`https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(zoneId)}${path}`, {
      timeout: 10_000,
      ...options,
      headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json', ...(options.headers || {}) },
    });
    if (!response.success) throw new Error(response.errors?.map((item) => item.message).filter(Boolean).join('; ') || 'Cloudflare API request failed');
    return response.result;
  } catch (error) {
    const statusCode = Number((error as { statusCode?: number }).statusCode || 0);
    if (statusCode === 503) throw error;
    const value = error as { data?: CloudflareEnvelope<unknown>; statusMessage?: string };
    const detail = value.data?.errors?.map((item) => item.message).filter(Boolean).join('; ')
      || value.statusMessage || (error instanceof Error ? error.message : 'Cloudflare API request failed');
    throw createError({ statusCode: 502, statusMessage: `Cloudflare domain operation failed: ${detail}` });
  }
};

export const testCloudflareZoneAccess = async (event: H3Event, zoneId: string) => {
  const apiToken = String(useRuntimeConfig(event).cloudflareApiToken || '').trim();
  if (!apiToken) return false;
  try {
    const response = await $fetch<CloudflareEnvelope<{ id: string }>>(`https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(zoneId)}`, {
      headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
      timeout: 10_000,
    });
    if (!response.success || response.result?.id !== zoneId) throw new Error(response.errors?.map((item) => item.message).filter(Boolean).join('; ') || 'Zone access denied');
    return true;
  } catch (error) {
    const value = error as { data?: CloudflareEnvelope<unknown>; statusMessage?: string };
    const detail = value.data?.errors?.map((item) => item.message).filter(Boolean).join('; ')
      || value.statusMessage || (error instanceof Error ? error.message : 'Zone access denied');
    throw createError({ statusCode: 409, statusMessage: `Cloudflare Zone validation failed: ${detail}` });
  }
};

const createCustomHostname = (event: H3Event, host: string) => cloudflareRequest<CloudflareCustomHostname>(event, '/custom_hostnames', {
  method: 'POST',
  body: {
    hostname: host,
    ssl: {
      method: 'http',
      type: 'dv',
      settings: { http2: 'on', min_tls_version: '1.2', tls_1_3: 'on' },
    },
  },
});

const findCustomHostname = async (event: H3Event, host: string) => {
  const matches = await cloudflareRequest<CloudflareCustomHostname[]>(event, '/custom_hostnames', {
    query: { hostname: host, per_page: 50 },
  });
  return matches.find((item) => item.hostname.toLowerCase() === host.toLowerCase()) || null;
};

export const ensureCloudflareCustomHostname = async (event: H3Event, host: string, hostnameId?: string | null) => {
  if (hostnameId) {
    try { return await cloudflareRequest<CloudflareCustomHostname>(event, `/custom_hostnames/${encodeURIComponent(hostnameId)}`); }
    catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (!message.includes('404') && !message.toLowerCase().includes('not found')) throw error;
    }
  }
  return (await findCustomHostname(event, host)) || createCustomHostname(event, host);
};

export const deleteCloudflareCustomHostname = (event: H3Event, hostnameId: string) =>
  cloudflareRequest<Record<string, never>>(event, `/custom_hostnames/${encodeURIComponent(hostnameId)}`, { method: 'DELETE' });

const certificateState = (sslStatus?: string): DomainConfig['certificate'] => {
  if (sslStatus === 'active') return '正常';
  if (['initializing', 'pending_validation', 'pending_issuance', 'pending_deployment', 'pending_cleanup'].includes(String(sslStatus))) return '签发中';
  return '未签发';
};

const validationRecords = (hostname: CloudflareCustomHostname): DomainValidationRecord[] =>
  (hostname.ssl?.validation_records || [])
    .filter((item) => item.txt_name && item.txt_value)
    .map((item) => ({ type: 'TXT', name: item.txt_name!, value: item.txt_value!, status: item.status || 'pending' }));

export const applyCloudflareHostnameState = (domain: DomainConfig, hostname: CloudflareCustomHostname) => {
  domain.cloudflareHostnameId = hostname.id;
  domain.cloudflareStatus = hostname.status;
  domain.sslStatus = hostname.ssl?.status || 'unknown';
  domain.certificate = certificateState(hostname.ssl?.status);
  domain.validationRecords = validationRecords(hostname);
  domain.provisioningError = [
    ...(hostname.verification_errors || []),
    ...(hostname.ssl?.validation_errors || []).map((item) => item.message || ''),
  ].filter(Boolean).join('; ') || null;
  return domain;
};
