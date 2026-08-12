import { homeData, seriesList } from '~/data/mock';
import type { AdminSeries, DomainConfig, PublishStatus, TaxonomyItem } from '~/types/admin';

export type { AdminSeries, DomainConfig, PublishStatus, TaxonomyItem } from '~/types/admin';

export type AdminOrderStatus = '已支付' | '处理中' | '支付失败' | '退款中' | '已退款' | '风控审核';

export interface AdminOrder {
  no: string;
  title: string;
  email: string;
  amount: number;
  fee: number;
  status: AdminOrderStatus;
  country: string;
  paypalOrderId: string;
  captureId: string;
  createdAt: string;
  callbackAt: string;
  entitlement: '已发放' | '待发放' | '已回收';
  note: string;
}

export interface HomeSectionConfig {
  id: string;
  title: string;
  subtitle: string;
  enabled: boolean;
  count: number;
  source: string;
  itemIds: string[];
}

export interface AuditLog {
  id: string;
  actor: string;
  module: string;
  action: string;
  target: string;
  detail: string;
  risk: '普通' | '高风险';
  ip: string;
  createdAt: string;
}

export interface SiteConfig {
  environment: 'sandbox' | 'production';
  clientId: string;
  secret: string;
  siteName: string;
  supportEmail: string;
  locale: string;
  includeFuture: boolean;
  revokeAfterRefund: boolean;
  freeEpisodes: number;
  signatureMinutes: number;
}

interface AdminState {
  series: AdminSeries[];
  orders: AdminOrder[];
  homeSections: HomeSectionConfig[];
  taxonomy: TaxonomyItem[];
  domains: DomainConfig[];
  auditLogs: AuditLog[];
  siteConfig: SiteConfig;
}

const today = '2026-08-09';

const createInitialState = (): AdminState => ({
  series: seriesList.map((series, index) => ({
    id: series.id,
    slug: series.slug,
    title: series.title,
    description: series.description,
    coverUrl: series.coverUrl,
    genres: series.genres,
    episodeCount: series.episodeCount,
    freeEpisodeCount: series.freeEpisodeCount,
    price: series.price,
    originalPrice: series.originalPrice,
    publishStatus: (['已上架', '处理中', '草稿', '待发布', '已下架'][index % 5]) as PublishStatus,
    publishAt: `2026-08-${String(8 - (index % 7)).padStart(2, '0')}`,
    transcodeProgress: index % 5 === 1 ? 68 : 100,
    targetRegion: index === 7 ? 'Global' : 'United States',
  })),
  orders: [
    { no: 'RN-20260809-10482', title: 'Vows & Vengeance', email: 'em***@gmail.com', amount: 4.99, fee: 0.44, status: '已支付', country: 'US', paypalOrderId: '8PE4••••L209', captureId: '6KL9••••P281', createdAt: `${today} 19:42`, callbackAt: `${today} 19:43`, entitlement: '已发放', note: '' },
    { no: 'RN-20260809-10481', title: 'The Heiress Returns', email: 'jo***@outlook.com', amount: 5.99, fee: 0, status: '处理中', country: 'US', paypalOrderId: '7KL2••••V889', captureId: '—', createdAt: `${today} 19:38`, callbackAt: '—', entitlement: '待发放', note: '等待 PayPal capture 确认' },
    { no: 'RN-20260809-10480', title: 'Deal With the Captain', email: 'sa***@gmail.com', amount: 5.99, fee: 0.47, status: '已支付', country: 'CA', paypalOrderId: '4AD8••••H102', captureId: '3NM2••••B908', createdAt: `${today} 19:31`, callbackAt: `${today} 19:32`, entitlement: '已发放', note: '' },
    { no: 'RN-20260809-10479', title: 'The Midnight CEO', email: 'ma***@icloud.com', amount: 5.99, fee: 0, status: '支付失败', country: 'US', paypalOrderId: '—', captureId: '—', createdAt: `${today} 19:20`, callbackAt: '—', entitlement: '待发放', note: '用户取消付款' },
    { no: 'RN-20260809-10478', title: 'Love on Paper', email: 'ol***@gmail.com', amount: 4.99, fee: 0.44, status: '退款中', country: 'GB', paypalOrderId: '2CS1••••N472', captureId: '9DF8••••M103', createdAt: `${today} 19:07`, callbackAt: `${today} 19:08`, entitlement: '已发放', note: '客服已受理重复购买申诉' },
    { no: 'RN-20260808-10391', title: 'Faking Forever', email: 'li***@gmail.com', amount: 3.99, fee: 0.40, status: '已退款', country: 'US', paypalOrderId: '1NR5••••E372', captureId: '8TG1••••W294', createdAt: '2026-08-08 16:22', callbackAt: '2026-08-08 16:23', entitlement: '已回收', note: '退款已完成' },
    { no: 'RN-20260808-10372', title: 'Queen Mom Rules', email: 'av***@yahoo.com', amount: 4.99, fee: 0.44, status: '风控审核', country: 'US', paypalOrderId: '3AB7••••D622', captureId: '—', createdAt: '2026-08-08 14:05', callbackAt: '—', entitlement: '待发放', note: '回调币种与订单快照不一致' },
    { no: 'RN-20260807-10218', title: 'Married by Monday', email: 'no***@gmail.com', amount: 4.99, fee: 0.44, status: '已支付', country: 'AU', paypalOrderId: '5HS8••••C551', captureId: '4WT6••••K833', createdAt: '2026-08-07 09:18', callbackAt: '2026-08-07 09:19', entitlement: '已发放', note: '' },
  ],
  homeSections: homeData.sections.map((section) => ({
    id: section.id,
    title: section.title,
    subtitle: section.subtitle,
    enabled: true,
    count: section.items.length,
    source: '手动推荐 + 热度排序',
    itemIds: section.items.map((item) => item.id),
  })),
  taxonomy: [
    { id: 'tax-01', name: 'Romance', localeName: '爱情', type: '分类', color: '#5d6bff', contentCount: 8, enabled: true, expiresAt: '—' },
    { id: 'tax-02', name: 'Revenge', localeName: '复仇', type: '分类', color: '#d65a67', contentCount: 4, enabled: true, expiresAt: '—' },
    { id: 'tax-03', name: 'Young Adult', localeName: '青春', type: '分类', color: '#2d9d78', contentCount: 3, enabled: true, expiresAt: '—' },
    { id: 'tag-01', name: 'Hot', localeName: '热门', type: '标签', color: '#f05b67', contentCount: 5, enabled: true, expiresAt: '2026-12-31' },
    { id: 'tag-02', name: 'New', localeName: '新上线', type: '标签', color: '#4d78e8', contentCount: 3, enabled: true, expiresAt: '2026-09-30' },
    { id: 'tag-03', name: 'Exclusive', localeName: '独家', type: '标签', color: '#8256c9', contentCount: 3, enabled: true, expiresAt: '—' },
    { id: 'tag-04', name: 'Free', localeName: '免费', type: '标签', color: '#26966f', contentCount: 1, enabled: false, expiresAt: '—' },
  ],
  domains: [],
  auditLogs: [
    { id: 'audit-001', actor: 'Admin', module: '支付配置', action: '切换运行环境', target: 'PayPal', detail: 'Sandbox → Production', risk: '高风险', ip: '172.16.24.18', createdAt: `${today} 18:20:41` },
    { id: 'audit-002', actor: 'Olivia Chen', module: '短剧管理', action: '上架短剧', target: 'Vows & Vengeance', detail: '待发布 → 已上架', risk: '普通', ip: '172.16.24.31', createdAt: `${today} 17:48:12` },
    { id: 'audit-003', actor: 'Daniel Wu', module: '订单管理', action: '标记退款受理', target: 'RN-20260809-10478', detail: '已支付 → 退款中', risk: '高风险', ip: '172.16.24.42', createdAt: `${today} 16:05:37` },
    { id: 'audit-004', actor: 'Admin', module: '域名管理', action: '添加备用域名', target: 'reelnova.tv', detail: '等待 DNS 验证', risk: '高风险', ip: '172.16.24.18', createdAt: `${today} 09:41:03` },
  ],
  siteConfig: {
    environment: 'sandbox', clientId: 'AQz8F3••••••••••••••••••E29', secret: '••••••••••••••••', siteName: 'ReelNova', supportEmail: 'support@reelnova.com', locale: 'en-US', includeFuture: true, revokeAfterRefund: true, freeEpisodes: 3, signatureMinutes: 10,
  },
});

export const useAdminStore = () => {
  const state = useState<AdminState>('admin-state', createInitialState);

  const addAudit = (entry: Omit<AuditLog, 'id' | 'actor' | 'ip' | 'createdAt'>) => {
    state.value.auditLogs.unshift({
      ...entry,
      id: `audit-${Date.now()}`,
      actor: 'Admin',
      ip: '172.16.24.18',
      createdAt: new Date().toLocaleString('zh-CN', { hour12: false }).replaceAll('/', '-'),
    });
  };

  const resetDemo = () => {
    state.value = createInitialState();
  };

  return { state, addAudit, resetDemo };
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
