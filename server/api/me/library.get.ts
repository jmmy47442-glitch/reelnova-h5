import { seriesList } from '~/data/mock';
import { ok } from '~/server/utils/response';
import { d1All, getVisitorId } from '~/server/utils/cloudflare-d1';
import { hydrateSeriesRuntimeData } from '~/server/utils/series-runtime';

interface ProgressRow { series_id: string; episode_no: number; position_seconds: number; duration_seconds: number }

export default defineEventHandler(async (event) => {
  const hydrated = await hydrateSeriesRuntimeData(event, seriesList);
  const progressRows = await d1All<ProgressRow>(event, `
    SELECT p.series_id, p.episode_no, p.position_seconds, p.duration_seconds FROM playback_events p
    INNER JOIN (SELECT series_id, MAX(created_at) AS latest FROM playback_events WHERE visitor_id = ? GROUP BY series_id) latest
      ON latest.series_id = p.series_id AND latest.latest = p.created_at
    WHERE p.visitor_id = ?
  `, [getVisitorId(event), getVisitorId(event)]);
  const progress = new Map(progressRows.map((row) => [row.series_id, row]));
  const withProgress = hydrated.map((series) => {
    const row = progress.get(series.id);
    return row ? { ...series, currentEpisode: Number(row.episode_no), progress: row.duration_seconds ? Math.min(100, Math.round(Number(row.position_seconds) / Number(row.duration_seconds) * 100)) : 0 } : series;
  });
  return ok({ continueWatching: withProgress.filter((series) => series.currentEpisode), purchased: withProgress.filter((series) => series.purchased) });
});
