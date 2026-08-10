import { ok } from '~/server/utils/response';
import { d1All, d1First } from '~/server/utils/cloudflare-d1';
import type { AdminAuditResponse, AuditLog, AuditRisk } from '~/types/admin';

interface AuditRow {
  id: string;
  actor: string;
  module: string;
  action: string;
  target: string;
  detail: string;
  risk: AuditRisk;
  ip: string | null;
  created_at: string;
}

interface CountRow { value: number }
interface ModuleRow { module: string }

const escapeLike = (value: string) => value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');

export default defineEventHandler(async (event) => {
  const query = getQuery(event);
  const page = Math.max(1, Number(query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(query.pageSize) || 20));
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (query.module) { conditions.push('module = ?'); params.push(String(query.module)); }
  if (query.risk && ['普通', '高风险'].includes(String(query.risk))) { conditions.push('risk = ?'); params.push(String(query.risk)); }
  if (query.keyword) {
    const keyword = `%${escapeLike(String(query.keyword).trim())}%`;
    conditions.push("(actor LIKE ? ESCAPE '\\' OR action LIKE ? ESCAPE '\\' OR target LIKE ? ESCAPE '\\' OR detail LIKE ? ESCAPE '\\' OR COALESCE(ip, '') LIKE ? ESCAPE '\\')");
    params.push(keyword, keyword, keyword, keyword, keyword);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const [rows, total, moduleRows] = await Promise.all([
    d1All<AuditRow>(event, `SELECT id, actor, module, action, target, detail, risk, ip, created_at
      FROM admin_audit_logs ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`, [...params, pageSize, (page - 1) * pageSize]),
    d1First<CountRow>(event, `SELECT COUNT(*) AS value FROM admin_audit_logs ${where}`, params),
    d1All<ModuleRow>(event, 'SELECT DISTINCT module FROM admin_audit_logs ORDER BY module'),
  ]);

  const data: AdminAuditResponse = {
    connected: true,
    generatedAt: new Date().toISOString(),
    items: rows.map((row): AuditLog => ({
      id: row.id,
      actor: row.actor,
      module: row.module,
      action: row.action,
      target: row.target,
      detail: row.detail,
      risk: row.risk,
      ip: row.ip,
      createdAt: row.created_at,
    })),
    total: Number(total?.value || 0),
    modules: moduleRows.map((row) => row.module),
  };
  return ok(data);
});
