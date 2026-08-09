import type { H3Event } from 'h3';
import type { Series } from '~/types/content';
import { d1All, getVisitorId } from '~/server/utils/cloudflare-d1';

interface ViewRow { series_id: string; views: number }
interface EntitlementRow { series_id: string }

export const hydrateSeriesRuntimeData = async (event: H3Event, source: Series[]) => {
  const visitorId = getVisitorId(event);
  const [viewRows, entitlementRows] = await Promise.all([
    d1All<ViewRow>(event, "SELECT series_id, COUNT(*) AS views FROM playback_events WHERE event_type = 'start' GROUP BY series_id"),
    d1All<EntitlementRow>(event, "SELECT series_id FROM entitlements WHERE visitor_id = ? AND status = 'granted'", [visitorId]),
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
