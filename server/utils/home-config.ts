import type { H3Event } from 'h3';
import { getSystemConfig, saveSystemConfig } from './system-config';

export interface StoredHomeSection {
  id: string;
  title: string;
  subtitle: string;
  enabled: boolean;
  count: number;
  source: string;
  itemIds: string[];
}

// Popular and New are automatic sections, not editable recommendation lists.
export const getHomeSections = async (event: H3Event) =>
  (await getSystemConfig<StoredHomeSection[]>(event, 'home', [])).filter((section) => !['popular', 'new'].includes(section.id));

export const saveHomeSections = async (event: H3Event, sections: StoredHomeSection[]) => {
  await saveSystemConfig(event, 'home', sections);
  return sections.map((section) => ({ ...section, itemIds: [...section.itemIds] }));
};
