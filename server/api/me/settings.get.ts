import { ok } from '~/server/utils/response';
import { d1First } from '~/server/utils/cloudflare-d1';
import { getUserSession } from '~/server/utils/user-auth';
import type { AccountSettings } from '~/types/user';

interface SettingsRow {
  language: AccountSettings['language'];
  recommendations: number;
  analytics: number;
  marketing: number;
  updated_at: string;
}

export default defineEventHandler(async (event) => {
  const session = await getUserSession(event);
  if (!session) throw createError({ statusCode: 401, statusMessage: 'Login required' });

  const row = await d1First<SettingsRow>(event, `SELECT language, recommendations, analytics, marketing, updated_at
    FROM user_preferences WHERE user_id = ?`, [session.userId]);
  return ok<AccountSettings>({
    language: row?.language || 'en',
    recommendations: row ? Boolean(row.recommendations) : true,
    analytics: row ? Boolean(row.analytics) : true,
    marketing: row ? Boolean(row.marketing) : false,
    updatedAt: row?.updated_at || null,
  });
});
