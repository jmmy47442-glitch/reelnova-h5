import type { H3Event } from 'h3';
import { d1Run, hasD1Connection } from './cloudflare-d1';
import type { AdminSession } from './admin-auth';

export const recordAdminAudit = async (event: H3Event, input: {
  module: string;
  action: string;
  target: string;
  detail: string;
  risk?: '普通' | '高风险';
}) => {
  if (!hasD1Connection(event)) return;
  const session = event.context.adminSession as AdminSession | undefined;
  await d1Run(event, `INSERT INTO admin_audit_logs
    (id, actor, actor_id, module, action, target, detail, risk, ip, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
    `audit_${crypto.randomUUID()}`,
    session?.name || '管理员',
    session?.id || null,
    input.module,
    input.action,
    input.target,
    input.detail,
    input.risk || '普通',
    getRequestIP(event, { xForwardedFor: true }) || null,
    new Date().toISOString(),
  ]);
};
