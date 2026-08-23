import { ok } from '~/server/utils/response';
import { d1First, d1Run, getRequestCountry } from '~/server/utils/cloudflare-d1';
import { getUserSession } from '~/server/utils/user-auth';
import { analyticsEventNames, type AnalyticsEventInput } from '~/types/content';

const allowedProperties = (value: unknown) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '{}';
  const entries = Object.entries(value as Record<string, unknown>).slice(0, 30)
    .filter(([, item]) => item === null || ['string', 'number', 'boolean'].includes(typeof item))
    .map(([key, item]) => [key.slice(0, 64), item] as const);
  return JSON.stringify(Object.fromEntries(entries));
};

export default defineEventHandler(async (event) => {
  const body = await readBody<AnalyticsEventInput>(event);
  const validNumber = (value: unknown, max = 86_400_000) => value === undefined || (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max);
  if (!body?.eventId || body.eventId.length > 100 || !body.sessionId || body.sessionId.length > 100
    || !analyticsEventNames.includes(body.eventName) || (body.pagePath && body.pagePath.length > 500)
    || (body.seriesId && body.seriesId.length > 100) || (body.seriesTitle && body.seriesTitle.length > 300)
    || (body.episodeNo !== undefined && (!Number.isInteger(body.episodeNo) || body.episodeNo < 1))
    || !validNumber(body.positionSeconds) || !validNumber(body.durationSeconds)) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid analytics event' });
  }
  const session = await getUserSession(event);
  if (session) {
    const preference = await d1First<{ analytics: number }>(event, 'SELECT analytics FROM user_preferences WHERE user_id = ?', [session.userId]);
    if (preference && !Number(preference.analytics)) return ok({ accepted: true as const });
  }
  const now = new Date().toISOString();
  await d1Run(event, `INSERT OR IGNORE INTO analytics_events
    (event_id, session_id, user_id, event_name, page_path, series_id, series_title, episode_no,
     position_seconds, duration_seconds, properties_json, country, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
    body.eventId, body.sessionId, session?.userId || null, body.eventName, body.pagePath || null,
    body.seriesId || null, body.seriesTitle || null, body.episodeNo ?? null,
    Math.round(body.positionSeconds || 0), Math.round(body.durationSeconds || 0), allowedProperties(body.properties), getRequestCountry(event), now,
  ]);
  return ok({ accepted: true as const });
});
