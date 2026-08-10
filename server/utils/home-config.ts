import type { H3Event } from 'h3';
import { homeData } from '~/data/mock';
import { d1First, d1Run, hasD1Connection } from '~/server/utils/cloudflare-d1';

export interface StoredHomeSection {
  id: string;
  title: string;
  subtitle: string;
  enabled: boolean;
  count: number;
  source: string;
  itemIds: string[];
}

interface HomeConfigRow { payload: string }

const isMissingTableError = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  const candidate = error as { statusMessage?: unknown; data?: { errors?: Array<{ message?: unknown }> } };
  const statusMessage = candidate?.statusMessage ? String(candidate.statusMessage) : '';
  const nestedMessages = candidate?.data?.errors?.map((item) => String(item.message || '')).join(' ') || '';
  const details = typeof error === 'object' && error ? JSON.stringify(error) : '';
  return `${message} ${statusMessage} ${nestedMessages} ${details}`.toLowerCase().includes('no such table');
};

const initialSections = (): StoredHomeSection[] => homeData.sections.map((section) => ({
  id: section.id,
  title: section.title,
  subtitle: section.subtitle,
  enabled: true,
  count: section.items.length,
  source: '手动推荐 + 热度排序',
  itemIds: section.items.map((item) => item.id),
}));

let memorySections = initialSections();

const clone = (sections: StoredHomeSection[]) => sections.map((section) => ({ ...section, itemIds: [...section.itemIds] }));

export const getHomeSections = async (event: H3Event) => {
  if (!hasD1Connection(event)) return clone(memorySections);
  try {
    const row = await d1First<HomeConfigRow>(event, 'SELECT payload FROM home_config WHERE id = ?', ['home']);
    if (!row?.payload) return clone(memorySections);
    const parsed = JSON.parse(row.payload) as StoredHomeSection[];
    if (Array.isArray(parsed)) {
      memorySections = parsed;
      return clone(parsed);
    }
  } catch {
    // Keep the mock fallback usable before the migration is applied.
  }
  return clone(memorySections);
};

export const saveHomeSections = async (event: H3Event, sections: StoredHomeSection[]) => {
  const value = clone(sections);
  memorySections = value;
  if (hasD1Connection(event)) {
    try {
      await d1Run(event, `INSERT INTO home_config (id, payload, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`,
      ['home', JSON.stringify(value), new Date().toISOString()]);
    } catch (error) {
      // Development deployments may be connected to D1 before migrations run.
      // The in-process value remains available until the migration is applied.
      if (!isMissingTableError(error)) throw error;
    }
  }
  return clone(value);
};
