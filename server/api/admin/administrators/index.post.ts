import { createAdminAccount, requireSuperAdmin } from '../../../utils/admin-auth';
import type { AssignableAdminRole } from '../../../../shared/admin-rbac';
import { recordAdminAudit } from '../../../utils/admin-audit';
import { ok } from '../../../utils/response';

export default defineEventHandler(async (event) => {
  const session = requireSuperAdmin(event);
  const body = await readBody<{ email?: string; name?: string; role?: AssignableAdminRole }>(event);
  const email = body.email?.trim().toLowerCase() || '';
  const name = body.name?.trim() || '';
  const role = body.role;
  if (!name || name.length > 80) throw createError({ statusCode: 400, statusMessage: 'Administrator name is required' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    throw createError({ statusCode: 400, statusMessage: 'Valid administrator email is required' });
  }
  if (role !== 'content_operator' && role !== 'finance_operator') {
    throw createError({ statusCode: 400, statusMessage: 'Assignable administrator role is required' });
  }
  const result = await createAdminAccount(event, { email, name, role, createdBy: session.id });
  await recordAdminAudit(event, { module: '管理员账号', action: '创建管理员', target: email, detail: `role=${role}`, risk: '高风险' });
  return ok(result);
});
