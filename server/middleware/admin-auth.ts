import { getAdminSession } from '../utils/admin-auth';
import { getAdminApiPermission } from '../../shared/admin-rbac';
import { requireAdminPermission } from '../utils/admin-rbac';

const publicAuthRoutes = new Set([
  '/api/admin/auth/challenge',
  '/api/admin/auth/login',
  '/api/admin/auth/logout',
  '/api/admin/auth/session',
]);

export default defineEventHandler(async (event) => {
  if (!event.path.startsWith('/api/admin')) return;
  const path = event.path.split('?')[0];
  if (publicAuthRoutes.has(path)) return;

  const config = useRuntimeConfig(event);
  if (String(config.cloudflareAccessRequired) === 'true') {
    if (!getHeader(event, 'cf-access-jwt-assertion')) {
      throw createError({ statusCode: 401, statusMessage: 'Cloudflare Access authentication required' });
    }
  }

  const session = await getAdminSession(event);
  if (session) {
    event.context.adminSession = session;
    const permission = getAdminApiPermission(path, event.method);
    if (!permission) throw createError({ statusCode: 403, statusMessage: 'No RBAC policy configured for this admin endpoint' });
    requireAdminPermission(event, permission);
    return;
  }
  throw createError({ statusCode: 401, statusMessage: 'Admin login required' });
});
