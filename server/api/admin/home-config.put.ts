import { ok } from '~/server/utils/response';
import { saveHomeSections, type StoredHomeSection } from '~/server/utils/home-config';
import { recordAdminAudit } from '~/server/utils/admin-audit';

const isValidSection = (value: StoredHomeSection) => value && typeof value.id === 'string' && typeof value.title === 'string'
  && typeof value.subtitle === 'string' && typeof value.source === 'string' && typeof value.enabled === 'boolean'
  && Number.isInteger(value.count) && value.count >= 1 && value.count <= 50
  && Array.isArray(value.itemIds) && value.itemIds.every((id) => typeof id === 'string');

export default defineEventHandler(async (event) => {
  const body = await readBody<{ items?: StoredHomeSection[] }>(event);
  if (!Array.isArray(body?.items) || !body.items.every(isValidSection)) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid home section configuration' });
  }
  const items = await saveHomeSections(event, body.items);
  await recordAdminAudit(event, { module: '首页配置', action: '发布首页配置', target: 'H5 首页', detail: `已保存 ${items.length} 个内容分区` });
  return ok({ items });
});
