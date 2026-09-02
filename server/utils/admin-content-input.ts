import type { AdminSeries, DomainConfig, PublishStatus, TaxonomyItem } from '~/types/admin';

export type SeriesMutationInput = Pick<AdminSeries, 'title' | 'description' | 'genres' | 'targetRegion' | 'freeEpisodeCount' | 'price'>;

export const parseSeriesInput = (value: Partial<SeriesMutationInput> | null | undefined): SeriesMutationInput => {
  const title = String(value?.title || '').trim();
  const description = String(value?.description || '').trim();
  const genres = Array.isArray(value?.genres) ? [...new Set(value.genres.map((item) => String(item).trim()).filter(Boolean))] : [];
  const targetRegion = String(value?.targetRegion || '').trim();
  const freeEpisodeCount = Number(value?.freeEpisodeCount);
  const price = Number(value?.price);
  if (!title || title.length > 80 || description.length > 500 || !genres.length || genres.length > 10
    || !targetRegion || !Number.isInteger(freeEpisodeCount) || freeEpisodeCount < 0 || freeEpisodeCount > 10000
    || !Number.isFinite(price) || price < 0 || price > 999.99) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid series data' });
  }
  return { title, description, genres, targetRegion, freeEpisodeCount, price: Math.round(price * 100) / 100 };
};

export const isPublishStatus = (value: unknown): value is PublishStatus =>
  ['已上架', '处理中', '草稿', '待发布', '已下架', '版权冻结'].includes(String(value));

export const isTaxonomyItem = (item: TaxonomyItem) => Boolean(item && typeof item.id === 'string'
  && typeof item.name === 'string' && item.name.trim() && item.name.length <= 50
  && typeof item.localeName === 'string' && item.localeName.trim() && item.localeName.length <= 50
  && ['分类', '标签'].includes(item.type) && /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(item.color)
  && typeof item.enabled === 'boolean' && (item.expiresAt === '—' || /^\d{4}-\d{2}-\d{2}$/.test(item.expiresAt)));

export const isDomainConfig = (item: DomainConfig) => Boolean(item && typeof item.id === 'string'
  && /^(?:[a-z0-9-]+\.)+[a-z]{2,}$/i.test(item.host) && ['主域名', '备用域名'].includes(item.role)
  && ['已验证', '待验证', '验证失败'].includes(item.verification)
  && ['正常', '即将到期', '签发中', '未签发'].includes(item.certificate) && typeof item.redirect === 'boolean');
