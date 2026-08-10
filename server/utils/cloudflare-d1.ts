import type { H3Event } from 'h3';

interface D1Statement {
  bind: (...values: unknown[]) => D1Statement;
  all: <T>() => Promise<{ results?: T[]; success: boolean; error?: string }>;
  run: () => Promise<{ success: boolean; error?: string; meta?: { changes?: number } }>;
  first: <T>() => Promise<T | null>;
}

interface D1Database {
  prepare: (sql: string) => D1Statement;
}

interface CloudflareContext {
  env?: { DB?: D1Database };
}

interface D1RestResult<T> {
  success: boolean;
  errors?: Array<{ message: string }>;
  result?: Array<{ success: boolean; results?: T[]; error?: string; meta?: { changes?: number } }>;
}

const d1RestTimeoutMs = 8_000;
const getBinding = (event: H3Event) => (event.context.cloudflare as CloudflareContext | undefined)?.env?.DB;

const getRestConfig = (event: H3Event) => {
  const config = useRuntimeConfig(event);
  return {
    accountId: config.cloudflareAccountId as string,
    databaseId: config.cloudflareD1DatabaseId as string,
    apiToken: config.cloudflareApiToken as string,
  };
};

export const hasD1Connection = (event: H3Event) => {
  if (getBinding(event)) return true;
  const { accountId, databaseId, apiToken } = getRestConfig(event);
  return Boolean(accountId && databaseId && apiToken);
};

const missingConfiguration = () => createError({
  statusCode: 503,
  statusMessage: 'Cloudflare D1 is not connected',
  data: { code: 'CLOUDFLARE_NOT_CONFIGURED', message: 'Configure the DB binding or CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_D1_DATABASE_ID and CLOUDFLARE_API_TOKEN.' },
});

const restQuery = async <T>(event: H3Event, sql: string, params: unknown[]) => {
  const { accountId, databaseId, apiToken } = getRestConfig(event);
  if (!accountId || !databaseId || !apiToken) throw missingConfiguration();
  const response = await $fetch<D1RestResult<T>>(`https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`, {
    method: 'POST',
    timeout: d1RestTimeoutMs,
    headers: { Authorization: `Bearer ${apiToken}` },
    body: { sql, params },
  });
  const result = response.result?.[0];
  if (!response.success || !result?.success) {
    throw createError({ statusCode: 502, statusMessage: result?.error || response.errors?.[0]?.message || 'Cloudflare D1 query failed' });
  }
  return result;
};

export const d1All = async <T>(event: H3Event, sql: string, params: unknown[] = []): Promise<T[]> => {
  const binding = getBinding(event);
  if (!binding) return (await restQuery<T>(event, sql, params)).results || [];
  const result = await binding.prepare(sql).bind(...params).all<T>();
  if (!result.success) throw createError({ statusCode: 502, statusMessage: result.error || 'Cloudflare D1 query failed' });
  return result.results || [];
};

export const d1First = async <T>(event: H3Event, sql: string, params: unknown[] = []): Promise<T | null> => {
  const binding = getBinding(event);
  if (!binding) return (await d1All<T>(event, sql, params))[0] || null;
  return binding.prepare(sql).bind(...params).first<T>();
};

export const d1Run = async (event: H3Event, sql: string, params: unknown[] = []) => {
  const binding = getBinding(event);
  if (!binding) return restQuery(event, sql, params);
  const result = await binding.prepare(sql).bind(...params).run();
  if (!result.success) throw createError({ statusCode: 502, statusMessage: result.error || 'Cloudflare D1 mutation failed' });
  return result;
};

export const getRequestCountry = (event: H3Event) => {
  const cloudflare = event.context.cloudflare as { request?: { cf?: { country?: string } } } | undefined;
  return cloudflare?.request?.cf?.country || getHeader(event, 'cf-ipcountry') || null;
};

export const getVisitorId = (event: H3Event) => {
  const existing = getCookie(event, 'rn_visitor');
  if (existing) return existing;
  const id = crypto.randomUUID();
  setCookie(event, 'rn_visitor', id, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 60 * 60 * 24 * 365, path: '/' });
  return id;
};
