import type { H3Event } from 'h3';
import type { AdminPermission } from '../../shared/admin-rbac';
import { hasAdminPermission } from '../../shared/admin-rbac';
import type { AdminSession } from './admin-auth';

export const requireAdminPermission = (event: H3Event, permission: AdminPermission) => {
  const session = event.context.adminSession as AdminSession | undefined;
  if (!session || !hasAdminPermission(session.role, permission)) {
    throw createError({ statusCode: 403, statusMessage: `Admin permission required: ${permission}` });
  }
  return session;
};
