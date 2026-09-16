import type { AdminSeries, DomainConfig, TaxonomyItem } from '~/types/admin';

export type { AdminSeries, DomainConfig, PublishStatus, TaxonomyItem } from '~/types/admin';

export interface HomeSectionConfig {
  id: string;
  title: string;
  subtitle: string;
  enabled: boolean;
  count: number;
  source: string;
  itemIds: string[];
}

interface AdminState {
  series: AdminSeries[];
  homeSections: HomeSectionConfig[];
  taxonomy: TaxonomyItem[];
  domains: DomainConfig[];
}

export const useAdminStore = () => {
  const state = useState<AdminState>('admin-state', () => ({
    series: [], homeSections: [], taxonomy: [], domains: [],
  }));
  return { state };
};

export const downloadCsv = (filename: string, headers: string[], rows: Array<Array<string | number>>) => {
  if (!import.meta.client) return;
  const escape = (value: string | number) => `"${String(value).replaceAll('"', '""')}"`;
  const content = [headers, ...rows].map((row) => row.map(escape).join(',')).join('\n');
  const url = URL.createObjectURL(new Blob([`\uFEFF${content}`], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
};
