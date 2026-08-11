import { deleteAdminAccount, requireSuperAdmin } from '../../../utils/admin-auth';
import { ok } from '../../../utils/response';
import { recordAdminAudit } from '../../../utils/admin-audit';

export default defineEventHandler(async (event) => {
  requireSuperAdmin(event);
  const id = getRouterParam(event, 'id') || '';
  if (!id) throw createError({ statusCode: 400, statusMessage: 'Administrator id is required' });
  const result = await deleteAdminAccount(event, id);
  await recordAdminAudit(event, { module: '管理员账号', action: '删除管理员', target: id, detail: '管理员账号已删除', risk: '高风险' });
  return ok(result);
});
