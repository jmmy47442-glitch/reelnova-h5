import { ok } from '~/server/utils/response';
import { d1All, d1First } from '~/server/utils/cloudflare-d1';
import type { AdminUsersResponse, PersistedUser, PersistedUserStatus } from '~/types/admin';

interface UserRow {
  visitor_id: string;
  email: string | null;
  country: string | null;
  device: string | null;
  status: PersistedUserStatus;
  created_at: string;
  last_seen_at: string;
  orders: number;
  entitlements: number;
}

interface CountRow { value: number }
interface CountryRow { country: string }

const escapeLike = (value: string) => value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');

const maskEmail = (value: string | null) => {
  if (!value) return '—';
  const [local, domain] = value.split('@');
  if (!local || !domain) return '—';
  return `${local.slice(0, Math.min(2, local.length))}***@${domain}`;
};

const mapUser = (row: UserRow): PersistedUser => ({
  id: row.visitor_id,
  email: maskEmail(row.email),
  country: row.country || '—',
  device: row.device || '未知设备',
  status: row.status,
  entitlements: Number(row.entitlements || 0),
  orders: Number(row.orders || 0),
  lastSeenAt: row.last_seen_at,
  createdAt: row.created_at,
});

export default defineEventHandler(async (event) => {
  const query = getQuery(event);
  const page = Math.max(1, Number(query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(query.pageSize) || 20));
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (query.status && ['active', 'restricted', 'disabled'].includes(String(query.status))) {
    conditions.push('u.status = ?');
    params.push(String(query.status));
  }
  if (query.country) {
    conditions.push('u.country = ?');
    params.push(String(query.country).toUpperCase());
  }
  if (query.keyword) {
    const keyword = `%${escapeLike(String(query.keyword).trim())}%`;
    conditions.push("(u.visitor_id LIKE ? ESCAPE '\\' OR u.email LIKE ? ESCAPE '\\' OR u.device LIKE ? ESCAPE '\\')");
    params.push(keyword, keyword, keyword);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const [rows, total, countryRows] = await Promise.all([
    d1All<UserRow>(event, `SELECT u.visitor_id, u.email, u.country, u.device, u.status, u.created_at, u.last_seen_at,
      (SELECT COUNT(*) FROM orders o WHERE o.visitor_id = u.visitor_id) AS orders,
      (SELECT COUNT(*) FROM (
        SELECT series_id FROM entitlements e WHERE e.visitor_id = u.visitor_id AND e.status = 'granted'
        UNION SELECT series_id FROM manual_entitlements m WHERE m.visitor_id = u.visitor_id AND m.status = 'granted'
      )) AS entitlements
      FROM users u ${where} ORDER BY u.last_seen_at DESC LIMIT ? OFFSET ?`, [...params, pageSize, (page - 1) * pageSize]),
    d1First<CountRow>(event, `SELECT COUNT(*) AS value FROM users u ${where}`, params),
    d1All<CountryRow>(event, "SELECT DISTINCT country FROM users WHERE country IS NOT NULL AND country != '' ORDER BY country"),
  ]);
  const data: AdminUsersResponse = {
    connected: true,
    generatedAt: new Date().toISOString(),
    items: rows.map(mapUser),
    total: Number(total?.value || 0),
    countries: countryRows.map((row) => row.country),
  };
  return ok(data);
});
