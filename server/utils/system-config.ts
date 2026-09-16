import type { H3Event } from 'h3';
import { d1First, d1Run } from './cloudflare-d1';

interface ConfigRow { payload: string }

export const getSystemConfig = async <T>(event: H3Event, id: string, fallback: T): Promise<T> => {
  const row = await d1First<ConfigRow>(event, 'SELECT payload FROM home_config WHERE id = ?', [id]);
  return row?.payload ? JSON.parse(row.payload) as T : fallback;
};

export const saveSystemConfig = async (event: H3Event, id: string, value: unknown) => {
  await d1Run(event, `INSERT INTO home_config (id, payload, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`,
  [id, JSON.stringify(value), new Date().toISOString()]);
};
