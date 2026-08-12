import type { H3Event } from 'h3';
import { d1First, d1Run, hasD1Connection } from './cloudflare-d1';

interface ConfigRow { payload: string }

const memorySettings = new Map<string, unknown>();

const isMissingConfigTable = (error: unknown) => {
  const value = error as { statusMessage?: unknown; data?: { errors?: Array<{ message?: unknown }> } };
  return `${error instanceof Error ? error.message : ''} ${String(value?.statusMessage || '')} ${value?.data?.errors?.map((item) => String(item.message || '')).join(' ') || ''}`
    .toLowerCase().includes('no such table');
};

export const getSystemConfig = async <T>(event: H3Event, id: string, fallback: T): Promise<T> => {
  if (!hasD1Connection(event)) return (memorySettings.get(id) as T | undefined) ?? fallback;
  try {
    const row = await d1First<ConfigRow>(event, 'SELECT payload FROM home_config WHERE id = ?', [id]);
    return row?.payload ? JSON.parse(row.payload) as T : fallback;
  } catch (error) {
    if (isMissingConfigTable(error)) return fallback;
    throw error;
  }
};

export const saveSystemConfig = async (event: H3Event, id: string, value: unknown) => {
  memorySettings.set(id, value);
  if (!hasD1Connection(event)) return;
  try {
    await d1Run(event, `INSERT INTO home_config (id, payload, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`,
    [id, JSON.stringify(value), new Date().toISOString()]);
  } catch (error) {
    if (!isMissingConfigTable(error)) throw error;
    throw createError({ statusCode: 503, statusMessage: 'Apply migration 0005 before changing system configuration' });
  }
};
