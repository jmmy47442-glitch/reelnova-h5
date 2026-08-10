import type { H3Event } from 'h3';
import { d1First, d1Run, getRequestCountry, getVisitorId } from '~/server/utils/cloudflare-d1';

export type UserStatus = 'active' | 'restricted' | 'disabled';

const normalizeEmail = (value?: string | null) => {
  const email = value?.trim().toLowerCase();
  return email && email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
};

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
  visitorId?: string;
  email?: string | null;
  country?: string | null;
  includeDevice?: boolean;
} = {}) => {
  const visitorId = input.visitorId || getVisitorId(event);
  const email = normalizeEmail(input.email);
  const country = normalizeCountry(input.country ?? getRequestCountry(event));
  const device = input.includeDevice === false ? null : summarizeDevice(getHeader(event, 'user-agent'));
  const now = new Date().toISOString();
  await d1Run(event, `INSERT INTO users
    (visitor_id, email, country, device, status, created_at, last_seen_at, updated_at)
    VALUES (?, ?, ?, ?, 'active', ?, ?, ?)
    ON CONFLICT(visitor_id) DO UPDATE SET
      email = COALESCE(excluded.email, users.email),
      country = COALESCE(excluded.country, users.country),
      device = COALESCE(excluded.device, users.device),
      last_seen_at = excluded.last_seen_at,
      updated_at = excluded.updated_at`, [visitorId, email, country, device, now, now, now]);
  return visitorId;
};

export const assertUserEnabled = async (event: H3Event, visitorId: string) => {
  const profile = await d1First<{ status: UserStatus }>(event, 'SELECT status FROM users WHERE visitor_id = ?', [visitorId]);
  if (profile?.status === 'disabled') throw createError({ statusCode: 403, statusMessage: 'User account is disabled' });
};

export const recordAdminUserAction = (event: H3Event, input: {
  visitorId: string;
  action: 'status_change' | 'device_restriction_release' | 'entitlement_grant';
  detail: string;
}) => {
  const session = event.context.adminSession as { email?: string } | undefined;
  return d1Run(event, `INSERT INTO admin_user_actions (id, visitor_id, actor, action, detail, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`, [
    crypto.randomUUID(),
    input.visitorId,
    getHeader(event, 'cf-access-authenticated-user-email') || session?.email || 'Admin',
    input.action,
    input.detail,
    new Date().toISOString(),
  ]);
};
