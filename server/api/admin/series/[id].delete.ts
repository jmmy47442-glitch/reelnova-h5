import { ok } from '~/server/utils/response';
import { recordAdminAudit } from '~/server/utils/admin-audit';
import { softDeleteManagedSeriesRecord } from '~/server/utils/managed-content';

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id') || '';
  const result = await softDeleteManagedSeriesRecord(event, id);
  await recordAdminAudit(event, {
    module: '短剧管理', action: '删除短剧', target: result.title,
    detail: `已软删除；保留关联订单 ${result.retainedOrderCount} 笔`, risk: '高风险',
  });
  return ok(result);
});
