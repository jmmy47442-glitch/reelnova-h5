import { ok } from '~/server/utils/response';
import { d1All } from '~/server/utils/cloudflare-d1';

interface EventCountRow { event_name: string; sessions: number; events: number }

export default defineEventHandler(async (event) => {
  const query = getQuery(event);
  const days = Math.min(90, Math.max(1, Number(query.days) || 7));
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const rows = await d1All<EventCountRow>(event, `SELECT event_name,
    COUNT(DISTINCT session_id) AS sessions, COUNT(*) AS events
    FROM analytics_events WHERE created_at >= ? GROUP BY event_name`, [since]);
  const byName = new Map(rows.map((row) => [row.event_name, { sessions: Number(row.sessions), events: Number(row.events) }]));
  const sessions = (names: string[]) => names.reduce((sum, name) => sum + (byName.get(name)?.sessions || 0), 0);
  const events = (names: string[]) => names.reduce((sum, name) => sum + (byName.get(name)?.events || 0), 0);
  const rate = (numerator: number, denominator: number) => denominator ? Number((numerator / denominator * 100).toFixed(2)) : 0;
  const homeExposure = sessions(['home_section_exposure', 'card_exposure']);
  const detailOpens = sessions(['detail_open']);
  const previewStarts = sessions(['preview_start']);
  const previewCompletes = sessions(['preview_complete']);
  const lockTriggers = sessions(['lock_trigger']);
  const paymentSheets = sessions(['payment_sheet_open']);
  const paymentSuccess = sessions(['payment_success']);
  const playbackStarts = sessions(['playback_start', 'preview_start']);
  return ok({
    periodDays: days, since, events: Object.fromEntries(rows.map((row) => [row.event_name, { sessions: Number(row.sessions), events: Number(row.events) }])),
    rates: {
      homeToDetail: rate(detailOpens, homeExposure),
      previewStart: rate(previewStarts, detailOpens),
      previewComplete: rate(previewCompletes, previewStarts),
      lockToPaymentSheet: rate(paymentSheets, lockTriggers),
      paymentSuccess: rate(paymentSuccess, paymentSheets),
      playbackFirstFrame: rate(sessions(['playback_first_frame']), playbackStarts),
      playbackStall: rate(events(['playback_stall']), events(['playback_start', 'preview_start'])),
      playbackFailure: rate(events(['playback_error']), events(['playback_start', 'preview_start'])),
      share: rate(sessions(['share']), detailOpens),
    },
    totals: {
      searches: events(['search']), shares: events(['share']), paypalClicks: events(['paypal_click']),
      paymentFailures: events(['payment_failure']), paymentCancels: events(['payment_cancel']),
      playbackCompletes: events(['playback_complete', 'preview_complete']),
    },
  });
});
