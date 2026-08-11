import { ok } from '~/server/utils/response';
import { d1First, d1Run } from '~/server/utils/cloudflare-d1';
import { getUserSession } from '~/server/utils/user-auth';
import type { AccountLanguage, AccountSettings } from '~/types/user';

const languages: AccountLanguage[] = ['en', 'es', 'pt', 'fr', 'de'];
interface SettingsRow {
  language: AccountLanguage;
  recommendations: number;
  analytics: number;
  marketing: number;
  updated_at: string;
}

export default defineEventHandler(async (event) => {
  const session = await getUserSession(event);
  if (!session) throw createError({ statusCode: 401, statusMessage: 'Login required' });
  const body = await readBody<Partial<AccountSettings>>(event);
  if (body.language !== undefined && !languages.includes(body.language)) {
    throw createError({ statusCode: 400, statusMessage: 'Unsupported language' });
  }
  for (const key of ['recommendations', 'analytics', 'marketing'] as const) {
    if (body[key] !== undefined && typeof body[key] !== 'boolean') {
      throw createError({ statusCode: 400, statusMessage: `Invalid ${key} preference` });
    }
  }

  const current = await d1First<SettingsRow>(event, `SELECT language, recommendations, analytics, marketing, updated_at
    FROM user_preferences WHERE user_id = ?`, [session.userId]);
  const now = new Date().toISOString();
  const next = {
    language: body.language ?? current?.language ?? 'en',
    recommendations: body.recommendations ?? (current ? Boolean(current.recommendations) : true),
    analytics: body.analytics ?? (current ? Boolean(current.analytics) : true),
    marketing: body.marketing ?? (current ? Boolean(current.marketing) : false),
  };
  await d1Run(event, `INSERT INTO user_preferences
    (user_id, language, recommendations, analytics, marketing, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET language = excluded.language,
      recommendations = excluded.recommendations, analytics = excluded.analytics,
      marketing = excluded.marketing, updated_at = excluded.updated_at`, [
    session.userId, next.language, Number(next.recommendations), Number(next.analytics),
    Number(next.marketing), current?.updated_at || now, now,
  ]);
  return ok<AccountSettings>({ ...next, updatedAt: now });
});
