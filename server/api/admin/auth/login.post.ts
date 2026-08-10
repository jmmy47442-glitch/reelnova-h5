import { authenticateAdmin, setAdminSession } from '../../../utils/admin-auth';
import { d1Run } from '../../../utils/cloudflare-d1';
import { ok } from '../../../utils/response';

export default defineEventHandler(async (event) => {
  const body = await readBody<{ email?: string; password?: string; remember?: boolean }>(event);
  const email = body.email?.trim().toLowerCase() || '';
  const password = body.password || '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 8) {
    throw createError({ statusCode: 400, statusMessage: 'Valid email and password are required' });
  }

  const account = await authenticateAdmin(event, email, password);
  if (!account) throw createError({ statusCode: 401, statusMessage: 'Invalid administrator credentials' });
  const session = await setAdminSession(event, account, body.remember !== false);
  const ip = getHeader(event, 'cf-connecting-ip') || getHeader(event, 'x-forwarded-for')?.split(',')[0]?.trim() || getHeader(event, 'x-real-ip') || null;
  await d1Run(event, `INSERT INTO admin_audit_logs (id, actor, actor_id, module, action, target, detail, risk, ip, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
    `login-${crypto.randomUUID()}`, session.email, session.id, '管理员账号', '管理员登录', session.email, '登录成功', '普通', ip, session.loggedInAt,
  ]);
  return ok(session);
});
