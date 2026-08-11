import type { TaxonomyItem } from '~/types/admin';
import { ok } from '~/server/utils/response';
import { recordAdminAudit } from '~/server/utils/admin-audit';
import { isTaxonomyItem } from '~/server/utils/admin-content-input';
import { saveTaxonomyConfig } from '~/server/utils/managed-content';

export default defineEventHandler(async (event) => {
  const body = await readBody<{ items?: TaxonomyItem[] }>(event);
  if (!Array.isArray(body?.items) || body.items.length > 200 || !body.items.every(isTaxonomyItem)) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid taxonomy configuration' });
  }
  const unique = new Set(body.items.map((item) => `${item.type}:${item.name.trim().toLowerCase()}`));
  if (unique.size !== body.items.length) throw createError({ statusCode: 409, statusMessage: 'Taxonomy names must be unique' });
  const items = await saveTaxonomyConfig(event, body.items.map((item) => ({ ...item, name: item.name.trim(), localeName: item.localeName.trim() })));
  await recordAdminAudit(event, { module: '分类与标签', action: '更新分类配置', target: '内容分类', detail: `已保存 ${items.length} 项配置` });
  return ok({ items });
});
