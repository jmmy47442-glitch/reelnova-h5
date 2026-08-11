import { ok } from '~/server/utils/response';
import { recordAdminAudit } from '~/server/utils/admin-audit';
import { parseSeriesInput } from '~/server/utils/admin-content-input';
import { createManagedSeries, getManagedSeries, saveManagedSeries, toAdminSeries } from '~/server/utils/managed-content';

export default defineEventHandler(async (event) => {
  const input = parseSeriesInput(await readBody(event));
  const items = await getManagedSeries(event);
  const created = createManagedSeries(items, input);
  items.unshift(created);
  await saveManagedSeries(event, items);
  await recordAdminAudit(event, { module: '短剧管理', action: '新建短剧', target: created.title, detail: `创建草稿 ${created.id}` });
  return ok(toAdminSeries(created));
});
