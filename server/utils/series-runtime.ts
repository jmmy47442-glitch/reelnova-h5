import type { H3Event } from 'h3';
import type { Series } from '~/types/content';
import { d1All, hasD1Connection } from '~/server/utils/cloudflare-d1';
import { getUserSession } from '~/server/utils/user-auth';

interface ViewRow { series_id: string; views: number }
interface EntitlementRow { series_id: string }
interface HistoryRow {
  series_id: string;
  episode_no: number;
  position_seconds: number;
  duration_seconds: number;
  completed: number;
  last_watched_at: string;
}

const viewsCacheTtlMs = 5_000;
let viewsCache: { expiresAt: number; value: ViewRow[] } | undefined;

const getViewRows = async (event: H3Event) => {
  if (viewsCache && viewsCache.expiresAt > Date.now()) return viewsCache.value;
  const value = await d1All<ViewRow>(event, "SELECT series_id, COUNT(*) AS views FROM playback_events WHERE event_type = 'start' GROUP BY series_id");
  viewsCache = { value, expiresAt: Date.now() + viewsCacheTtlMs };
  return value;
};

export const hydrateSeriesRuntimeData = async (event: H3Event, source: Series[]): Promise<Series[]> => {
  // Local previews can use the built-in catalogue without a D1 connection.
  // Runtime counters and purchase state simply start empty in that mode.
  if (!hasD1Connection(event)) {
    return source.map((series) => ({
      ...series,
      views: 0,
      purchased: false,
      episodes: series.episodes.map((episode) => ({ ...episode, isUnlocked: episode.isFree })),
    }));
  }
  const userId = (await getUserSession(event))?.userId;
  const [viewRows, entitlementRows, historyRows] = await Promise.all([
    getViewRows(event),
    userId
      ? d1All<EntitlementRow>(event, `SELECT series_id FROM entitlements WHERE user_id = ? AND status = 'granted'
        UNION SELECT series_id FROM manual_entitlements WHERE user_id = ? AND status = 'granted'`, [userId, userId])
      : Promise.resolve([]),
    userId
      ? d1All<HistoryRow>(event, `SELECT series_id, episode_no, position_seconds, duration_seconds, completed, last_watched_at
        FROM watch_history WHERE user_id = ?`, [userId])
      : Promise.resolve([]),
  ]);
  const views = new Map(viewRows.map((row) => [row.series_id, Number(row.views)]));
  const purchased = new Set(entitlementRows.map((row) => row.series_id));
  const history = new Map(historyRows.map((row) => [row.series_id, row]));
  return source.map((series) => {
    const isPurchased = purchased.has(series.id);
    const watched = history.get(series.id);
    const duration = Math.max(0, Number(watched?.duration_seconds || 0));
    const position = Math.max(0, Number(watched?.position_seconds || 0));
    const progress = watched ? (watched.completed ? 100 : duration ? Math.min(100, Math.round(position / duration * 100)) : 0) : undefined;
    return {
      ...series,
      views: views.get(series.id) || 0,
      purchased: isPurchased,
      progress,
      currentEpisode: watched ? Number(watched.episode_no) : undefined,
      positionSeconds: watched ? position : undefined,
      durationSeconds: watched ? duration : undefined,
      lastWatchedAt: watched?.last_watched_at,
      completed: watched ? Boolean(watched.completed) : undefined,
      episodes: series.episodes.map((episode) => ({ ...episode, isUnlocked: episode.isFree || isPurchased })),
    };
  });
};
