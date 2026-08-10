import type { H3Event } from 'h3';
import { d1First, d1Run, getRequestCountry } from '~/server/utils/cloudflare-d1';

export type UserStatus = 'active' | 'restricted' | 'disabled';

const normalizeCountry = (value?: string | null) => {
  const country = value?.trim().toUpperCase();
  return country && /^[A-Z]{2}$/.test(country) ? country : null;
};

export const summarizeDevice = (userAgent?: string | null) => {
  if (!userAgent) return null;
  const platform = /iPad/i.test(userAgent) ? 'iPad'
    : /iPhone/i.test(userAgent) ? 'iPhone'
      : /Android/i.test(userAgent) ? 'Android'
        : /Windows/i.test(userAgent) ? 'Windows'
          : /Macintosh|Mac OS X/i.test(userAgent) ? 'Mac'
            : /Linux/i.test(userAgent) ? 'Linux'
              : 'Other';
  const browser = /Edg(?:A|iOS)?\//i.test(userAgent) ? 'Edge'
    : /(?:CriOS|Chrome)\//i.test(userAgent) ? 'Chrome'
      : /(?:FxiOS|Firefox)\//i.test(userAgent) ? 'Firefox'
        : /Safari\//i.test(userAgent) ? 'Safari'
          : 'Browser';
  return `${platform} · ${browser}`;
};

export const upsertUserProfile = async (event: H3Event, input: {
  userId: string;
  country?: string | null;
  includeDevice?: boolean;
}) => {
  const userId = input.userId;
  const country = normalizeCountry(input.country ?? getRequestCountry(event));
  const device = input.includeDevice === false ? null : summarizeDevice(getHeader(event, 'user-agent'));
  const now = new Date().toISOString();
  await d1Run(event, `UPDATE users SET
    country = COALESCE(?, country),
    device = COALESCE(?, device),
    last_seen_at = ?,
    updated_at = ?
    WHERE user_id = ?`, [country, device, now, now, userId]);
  return userId;
};

export const assertUserEnabled = async (event: H3Event, userId: string) => {
  const profile = await d1First<{ status: UserStatus }>(event, 'SELECT status FROM users WHERE user_id = ?', [userId]);
  if (!profile) throw createError({ statusCode: 404, statusMessage: 'User not found' });
  if (profile.status === 'disabled') throw createError({ statusCode: 403, statusMessage: 'User account is disabled' });
};

export const recordAdminUserAction = (event: H3Event, input: {
  userId: string;
  action: 'status_change' | 'device_restriction_release' | 'entitlement_grant';
  detail: string;
}) => {
  const session = event.context.adminSession as { id?: string; email?: string } | undefined;
  const actor = getHeader(event, 'cf-access-authenticated-user-email') || session?.email || 'Admin';
  const ip = getHeader(event, 'cf-connecting-ip') || getHeader(event, 'x-forwarded-for')?.split(',')[0]?.trim() || getHeader(event, 'x-real-ip') || null;
  const createdAt = new Date().toISOString();
  const id = crypto.randomUUID();
  const actionLabel = input.action === 'status_change'
    ? (input.detail.endsWith('-> disabled') ? '禁用账号' : input.detail.endsWith('-> active') ? '恢复账号' : '变更账号状态')
    : input.action === 'device_restriction_release' ? '解除设备限制' : '手工补发权益';
  return Promise.all([
    d1Run(event, `INSERT INTO admin_user_actions (id, user_id, actor, action, detail, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`, [id, input.userId, actor, input.action, input.detail, createdAt]),
    d1Run(event, `INSERT INTO admin_audit_logs (id, actor, actor_id, module, action, target, detail, risk, ip, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      `user-action-${id}`, actor, session?.id || null, '用户与权益', actionLabel, input.userId, input.detail, '高风险', ip, createdAt,
    ]),
  ]);
};
