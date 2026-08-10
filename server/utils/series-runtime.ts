import type { H3Event } from 'h3';
import type { Series } from '~/types/content';
import { d1All } from '~/server/utils/cloudflare-d1';
import { getUserSession } from '~/server/utils/user-auth';

interface ViewRow { series_id: string; views: number }
interface EntitlementRow { series_id: string }

export const hydrateSeriesRuntimeData = async (event: H3Event, source: Series[]) => {
  const userId = (await getUserSession(event))?.userId;
  const [viewRows, entitlementRows] = await Promise.all([
    d1All<ViewRow>(event, "SELECT series_id, COUNT(*) AS views FROM playback_events WHERE event_type = 'start' GROUP BY series_id"),
    userId
      ? d1All<EntitlementRow>(event, `SELECT series_id FROM entitlements WHERE user_id = ? AND status = 'granted'
        UNION SELECT series_id FROM manual_entitlements WHERE user_id = ? AND status = 'granted'`, [userId, userId])
      : Promise.resolve([]),
  ]);
  const views = new Map(viewRows.map((row) => [row.series_id, Number(row.views)]));
  const purchased = new Set(entitlementRows.map((row) => row.series_id));
  return source.map((series) => {
    const isPurchased = purchased.has(series.id);
    return {
      ...series,
      views: views.get(series.id) || 0,
      purchased: isPurchased,
      progress: undefined,
      currentEpisode: undefined,
      episodes: series.episodes.map((episode) => ({ ...episode, isUnlocked: episode.isFree || isPurchased })),
    };
  });
};
