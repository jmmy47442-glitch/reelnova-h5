import { requireSuperAdmin, updateAdminRole, updateAdminStatus } from '../../../utils/admin-auth';
import type { AssignableAdminRole } from '../../../../shared/admin-rbac';
import { recordAdminAudit } from '../../../utils/admin-audit';
import { ok } from '../../../utils/response';

export default defineEventHandler(async (event) => {
  requireSuperAdmin(event);
  const id = getRouterParam(event, 'id') || '';
  const body = await readBody<{ status?: 'active' | 'disabled'; role?: AssignableAdminRole }>(event);
  if (!id) throw createError({ statusCode: 400, statusMessage: 'Administrator id is required' });
  if (body.role && ['content_operator', 'finance_operator'].includes(body.role)) {
    const account = await updateAdminRole(event, id, body.role);
    await recordAdminAudit(event, { module: '管理员账号', action: '变更管理员岗位', target: account.email, detail: `role=${body.role}`, risk: '高风险' });
    return ok(account);
  }
  if (body.status && ['active', 'disabled'].includes(body.status)) {
    const account = await updateAdminStatus(event, id, body.status);
    await recordAdminAudit(event, { module: '管理员账号', action: body.status === 'disabled' ? '停用管理员' : '恢复管理员', target: account.email, detail: `status=${body.status}`, risk: '高风险' });
    return ok(account);
  }
  throw createError({ statusCode: 400, statusMessage: 'Valid administrator role or status is required' });
});
