import { readFileSync } from 'node:fs';

// This fixture is deliberately explicit and idempotent. It seeds catalogue and
// transaction records for MVP acceptance without making the public API depend
// on the in-memory prototype catalogue.
const envFile = process.env.ACCEPTANCE_ENV_FILE || '.env';
try {
  for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, '');
  }
} catch {
  // CI can provide the three Cloudflare variables directly.
}

const { CLOUDFLARE_ACCOUNT_ID: accountId, CLOUDFLARE_D1_DATABASE_ID: databaseId, CLOUDFLARE_API_TOKEN: apiToken } = process.env;
if (!accountId || !databaseId || !apiToken) throw new Error('CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_D1_DATABASE_ID and CLOUDFLARE_API_TOKEN are required');

const endpoint = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/d1/database/${encodeURIComponent(databaseId)}/query`;
const query = async (sql, params = []) => {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql, params }),
  });
  const payload = await response.json().catch(() => ({}));
  const failed = payload.result?.find((result) => !result.success);
  if (!response.ok || !payload.success || failed) throw new Error(failed?.error || payload.errors?.[0]?.message || `D1 request failed (${response.status})`);
  return payload.result?.[0]?.results || [];
};

const streamRequest = async (path, options = {}) => {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/stream${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.success) throw new Error(payload.errors?.[0]?.message || `Stream request failed (${response.status})`);
  return payload.result;
};

const now = new Date().toISOString();
const includeTransactionFixtures = process.argv.includes('--with-transactions')
  || process.env.ACCEPTANCE_INCLUDE_TRANSACTION_FIXTURES === 'true';
const acceptanceUserId = 'usr_acceptance_2026';
const acceptanceEmail = 'mvp-acceptance@reelnova.test';
const refundUserId = 'usr_acceptance_refund_2026';
const refundEmail = 'mvp-refund-acceptance@reelnova.test';
const series = [
  { id: 'sr-0da51aed', slug: 'big-buck-bunny-acceptance-cut', title: 'Big Buck Bunny: Acceptance Cut', tagline: 'An open movie prepared for ReelNova playback acceptance.', description: 'A three-part technical acceptance cut of the Blender Foundation open movie Big Buck Bunny.', cover: '/api/media/poster/sr-0da51aed?variant=cover', backdrop: '/api/media/poster/sr-0da51aed?variant=backdrop', badge: 'Free Preview', genres: ['Animation', 'Comedy'], cast: ['Blender Foundation'], free: 1, price: 99, original: 199, director: 'Sacha Goedegebure', copyright: 'Big Buck Bunny (c) 2008 Blender Foundation | peach.blender.org | Licensed under CC BY 3.0', episodes: 3 },
  { id: 'acc-sintel', slug: 'sintel-acceptance-excerpt', title: 'Sintel: Acceptance Excerpt', tagline: 'A lone warrior searches for the dragon she once rescued.', description: 'A rights-cleared acceptance excerpt from the Blender Foundation open movie Sintel.', cover: '/api/media/poster/acc-sintel?variant=cover', backdrop: '/api/media/poster/acc-sintel?variant=backdrop', badge: 'Open Movie', genres: ['Animation', 'Fantasy'], cast: ['Durian Open Movie Project'], free: 1, price: 0, original: null, director: 'Colin Levy', copyright: 'Sintel (c) Blender Foundation | durian.blender.org | Licensed under CC BY 3.0', episodes: 1 },
  { id: 'acc-tears-of-steel', slug: 'tears-of-steel-acceptance-excerpt', title: 'Tears of Steel: Acceptance Excerpt', tagline: 'A group of warriors and scientists gather for a final battle.', description: 'A rights-cleared acceptance excerpt from the Blender Foundation open movie Tears of Steel.', cover: '/api/media/poster/acc-tears-of-steel?variant=cover', backdrop: '/api/media/poster/acc-tears-of-steel?variant=backdrop', badge: 'Open Movie', genres: ['Science Fiction', 'Action'], cast: ['Mango Open Movie Project'], free: 1, price: 0, original: null, director: 'Ian Hubert', copyright: 'Tears of Steel (c) Blender Foundation | mango.blender.org | Licensed under CC BY 3.0', episodes: 1 },
  { id: 'acc-elephants-dream', slug: 'elephants-dream-acceptance-copy', title: 'Elephants Dream: Acceptance Copy', tagline: 'Two explorers journey through the machinery of an impossible world.', description: 'A rights-cleared acceptance copy of the Blender Foundation open movie Elephants Dream.', cover: '/api/media/poster/acc-elephants-dream?variant=cover', backdrop: '/api/media/poster/acc-elephants-dream?variant=backdrop', badge: 'Open Movie', genres: ['Animation', 'Fantasy'], cast: ['Orange Open Movie Project'], free: 1, price: 0, original: null, director: 'Bassam Kurdali', copyright: 'Elephants Dream (c) Blender Foundation | orange.blender.org | Licensed under CC BY 2.5', episodes: 1 },
  { id: 'acc-cosmos-laundromat', slug: 'cosmos-laundromat-acceptance-copy', title: 'Cosmos Laundromat: Acceptance Copy', tagline: 'On a desolate island, a sheep is offered the deal of a lifetime.', description: 'A rights-cleared acceptance copy of the Blender Foundation open movie Cosmos Laundromat.', cover: '/api/media/poster/acc-cosmos-laundromat?variant=cover', backdrop: '/api/media/poster/acc-cosmos-laundromat?variant=backdrop', badge: 'Open Movie', genres: ['Animation', 'Comedy'], cast: ['Gooseberry Open Movie Project'], free: 1, price: 0, original: null, director: 'Mathieu Auvray', copyright: 'Cosmos Laundromat (c) Blender Foundation | gooseberry.blender.org | Licensed under CC BY-SA 3.0', episodes: 1 },
];

const categories = [...new Set(series.flatMap((item) => item.genres))];
const tags = [...new Set(series.map((item) => item.badge))];
const episodeTitles = ['Part 1: A quiet morning', 'Part 2: The troublemakers', 'Part 3: Bunny strikes back', 'Part 4', 'Part 5', 'Part 6'];
const streamFixtures = [
  { seriesId: 'acc-sintel', creator: 'acc-sintel', fileName: 'Sintel_webm_extract.240p.vp9.webm', sourceUrl: 'https://commons.wikimedia.org/wiki/File:Sintel_webm_extract.webm', copyUrl: 'https://upload.wikimedia.org/wikipedia/commons/transcoded/2/25/Sintel_webm_extract.webm/Sintel_webm_extract.webm.240p.vp9.webm', sourceSize: 7756199 },
  { seriesId: 'acc-tears-of-steel', creator: 'acc-tears-steel', fileName: 'VP9_low_bitrate_test_ToS.webm', sourceUrl: 'https://commons.wikimedia.org/wiki/File:VP9_low_bitrate_test_ToS.webm', copyUrl: 'https://upload.wikimedia.org/wikipedia/commons/a/ad/VP9_low_bitrate_test_ToS.webm', sourceSize: 852395 },
  { seriesId: 'acc-elephants-dream', creator: 'acc-elephants-dream', fileName: 'Elephants_Dream_120p.webm', sourceUrl: 'https://commons.wikimedia.org/wiki/File:Elephants_Dream_(2006).120p.vp9.opus.multichannel.webm', copyUrl: 'https://upload.wikimedia.org/wikipedia/commons/d/d3/Elephants_Dream_%282006%29.120p.vp9.opus.multichannel.webm', sourceSize: 14327747 },
  { seriesId: 'acc-cosmos-laundromat', creator: 'acc-cosmos-laundromat', fileName: 'Cosmos_Laundromat_240p.webm', sourceUrl: 'https://commons.wikimedia.org/wiki/File:Cosmos_Laundromat_-_First_Cycle_-_Official_Blender_Foundation_release.webm', copyUrl: 'https://upload.wikimedia.org/wikipedia/commons/transcoded/3/36/Cosmos_Laundromat_-_First_Cycle_-_Official_Blender_Foundation_release.webm/Cosmos_Laundromat_-_First_Cycle_-_Official_Blender_Foundation_release.webm.240p.vp9.webm', sourceSize: 594685641 },
];

const run = (sql, params = []) => query(sql, params);
const verify = async () => {
  const [summary] = await query(`SELECT
    (SELECT COUNT(*) FROM series WHERE id LIKE 'acc-%' OR id = 'sr-0da51aed') AS series_count,
    (SELECT COUNT(*) FROM episodes WHERE series_id IN (SELECT id FROM series WHERE id LIKE 'acc-%' OR id = 'sr-0da51aed')) AS episode_count,
    (SELECT COUNT(*) FROM media_assets a JOIN episodes e ON e.id = a.episode_id WHERE e.series_id = 'sr-0da51aed' AND a.status = 'ready') AS ready_asset_count,
    (SELECT COUNT(DISTINCT e.series_id) FROM media_assets a JOIN episodes e ON e.id = a.episode_id
      WHERE e.series_id IN (SELECT id FROM series WHERE id LIKE 'acc-%' OR id = 'sr-0da51aed') AND a.status = 'ready') AS ready_series_count,
    (SELECT COUNT(*) FROM series WHERE (id LIKE 'acc-%' OR id = 'sr-0da51aed') AND copyright_notice <> '') AS licensed_series_count,
    (SELECT json_array_length(payload) FROM home_config WHERE id = 'home') AS section_count,
    (SELECT COUNT(*) FROM orders WHERE order_no LIKE 'RN-ACCEPT-%' AND status = 'paid') AS paid_count,
    (SELECT COUNT(*) FROM orders WHERE order_no LIKE 'RN-ACCEPT-%' AND status = 'refunded') AS refunded_count,
    (SELECT COUNT(*) FROM entitlements WHERE id = 'ent-accept-refunded-2026' AND status = 'revoked') AS revoked_count,
    (SELECT COUNT(*) FROM watch_history WHERE user_id = 'usr_acceptance_2026' AND series_id = 'sr-0da51aed') AS history_count`);
  const result = Object.fromEntries(Object.entries(summary || {}).map(([key, value]) => [key, Number(value)]));
  const transactionStateValid = includeTransactionFixtures
    ? result.paid_count >= 1 && result.refunded_count >= 1 && result.revoked_count >= 1 && result.history_count >= 1
    : result.paid_count === 0 && result.refunded_count === 0 && result.revoked_count === 0 && result.history_count === 0;
  const valid = result.series_count >= 5 && result.episode_count >= 7 && result.ready_asset_count >= 3
    && result.ready_series_count >= 5 && result.licensed_series_count >= 5
    && result.section_count >= 5 && transactionStateValid;
  console.log(JSON.stringify(result, null, 2));
  if (!valid) throw new Error('Acceptance data is incomplete');
};

if (process.argv.includes('--check')) {
  await verify();
  process.exit(0);
}

// Keep the three existing ready Stream assets, but move their series into the
// stable acceptance namespace so old orders remain attached to the same rows.
await run(`UPDATE series SET id = ?, slug = ?, title = ?, tagline = ?, description = ?, cover_url = ?, backdrop_url = ?, badge = ?,
  cast_json = ?, director = ?, copyright_notice = ?, free_episode_count = ?, price_cents = ?, original_price_cents = ?, status = 'published', published_at = COALESCE(published_at, ?), updated_at = ?
  WHERE id = 'sr-0da51aed'`, [series[0].id, series[0].slug, series[0].title, series[0].tagline, series[0].description, series[0].cover, series[0].backdrop, series[0].badge, JSON.stringify(series[0].cast), series[0].director, series[0].copyright, series[0].free, series[0].price, series[0].original, now, now]);
await run(`UPDATE episodes SET series_id = ? WHERE series_id = 'sr-0da51aed'`, [series[0].id]);
await run(`UPDATE orders SET series_id = ?, series_slug = ?, series_title = ? WHERE series_id = 'sr-0da51aed'`, [series[0].id, series[0].slug, series[0].title]);

for (const staleId of ['acc-heiress-returns', 'acc-faking-forever', 'acc-queen-mom', 'acc-goodbye-captain']) {
  await run('DELETE FROM series_categories WHERE series_id = ?', [staleId]);
  await run('DELETE FROM series_tags WHERE series_id = ?', [staleId]);
  await run('DELETE FROM episodes WHERE series_id = ?', [staleId]);
  await run('DELETE FROM series WHERE id = ?', [staleId]);
}

for (const item of series.slice(1)) {
  await run(`INSERT INTO series (id, slug, title, tagline, description, cover_url, backdrop_url, badge, target_region, language,
    subtitle_languages, cast_json, director, copyright_notice, free_episode_count, price_cents, original_price_cents, currency, status, published_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'United States', 'en', '[]', ?, ?, ?, ?, ?, ?, 'USD', 'published', ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET slug=excluded.slug, title=excluded.title, tagline=excluded.tagline, description=excluded.description,
      cover_url=excluded.cover_url, backdrop_url=excluded.backdrop_url, badge=excluded.badge, cast_json=excluded.cast_json, director=excluded.director, copyright_notice=excluded.copyright_notice,
      free_episode_count=excluded.free_episode_count, price_cents=excluded.price_cents, original_price_cents=excluded.original_price_cents,
      status='published', published_at=excluded.published_at, updated_at=excluded.updated_at, deleted_at=NULL`,
  [item.id, item.slug, item.title, item.tagline, item.description, item.cover, item.backdrop, item.badge, JSON.stringify(item.cast), item.director, item.copyright, item.free, item.price, item.original, now, now, now]);
}

for (const item of series) {
  await run('DELETE FROM episodes WHERE series_id = ? AND episode_no > ?', [item.id, item.episodes]);
  for (let episodeNo = 1; episodeNo <= item.episodes; episodeNo += 1) {
    const episodeId = `acc-ep-${item.id.slice(4)}-${episodeNo}`;
    await run(`INSERT INTO episodes (id, series_id, episode_no, title, duration_seconds, is_free, video_status, thumbnail_url, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(series_id, episode_no) DO UPDATE SET title=excluded.title, duration_seconds=excluded.duration_seconds,
        is_free=excluded.is_free, thumbnail_url=excluded.thumbnail_url, updated_at=excluded.updated_at`,
    [episodeId, item.id, episodeNo, item.id === series[0].id ? episodeTitles[episodeNo - 1] : `Episode ${episodeNo}`, item.id === series[0].id && episodeNo <= 3 ? 60 : 150 + episodeNo * 11, episodeNo <= item.free ? 1 : 0, item.id === series[0].id && episodeNo <= 3 ? 'ready' : 'waiting_upload', item.cover, now, now]);
  }
}

for (const fixture of streamFixtures) {
  const existing = await streamRequest(`?creator=${encodeURIComponent(fixture.creator)}&limit=5`);
  let video = existing?.find((candidate) => candidate.creator === fixture.creator);
  if (!video) video = await streamRequest('/copy', {
    method: 'POST',
    headers: { 'Upload-Creator': fixture.creator },
    body: JSON.stringify({ url: fixture.copyUrl, creator: fixture.creator, meta: { acceptanceFixture: 'P0-04', seriesId: fixture.seriesId }, requireSignedURLs: true }),
  });
  if (!video?.uid) throw new Error(`Cloudflare Stream fixture is missing: ${fixture.creator}`);
  for (let attempt = 0; attempt < 120 && !video.readyToStream && video.status?.state !== 'ready'; attempt += 1) {
    if (video.status?.state === 'error') throw new Error(`Cloudflare Stream fixture failed: ${fixture.creator}: ${video.status?.errorReasonText || 'unknown error'}`);
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    video = await streamRequest(`/${encodeURIComponent(video.uid)}`);
  }
  const ready = Boolean(video.readyToStream || video.status?.state === 'ready');
  if (!ready) throw new Error(`Timed out waiting for Cloudflare Stream fixture: ${fixture.creator}`);
  const assetId = `acc-media-${fixture.seriesId.slice(4)}`;
  const episodeId = `acc-ep-${fixture.seriesId.slice(4)}-1`;
  await run(`INSERT INTO media_assets (id, episode_id, kind, storage_provider, source_object_key, stream_uid, source_file_name, source_content_type,
    source_size_bytes, width, height, duration_seconds, has_video, has_audio, validation_status, hls_url, dash_url, thumbnail_url, status, created_at, updated_at)
    VALUES (?, ?, 'video', 'stream', ?, ?, ?, 'video/webm', ?, ?, ?, ?, 1, 1, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET stream_uid=excluded.stream_uid, width=excluded.width, height=excluded.height, duration_seconds=excluded.duration_seconds,
      validation_status=excluded.validation_status, hls_url=excluded.hls_url, dash_url=excluded.dash_url, thumbnail_url=excluded.thumbnail_url,
      status=excluded.status, updated_at=excluded.updated_at, deleted_at=NULL`,
  [assetId, episodeId, fixture.sourceUrl, video.uid, fixture.fileName, fixture.sourceSize, Number(video.input?.width || 0) || null,
    Number(video.input?.height || 0) || null, Number(video.duration || 0) || null, ready ? 'valid' : 'pending', video.playback?.hls || null,
    video.playback?.dash || null, video.thumbnail || null, ready ? 'ready' : 'processing', now, now]);
  await run(`INSERT INTO transcode_jobs (id, media_asset_id, provider_job_id, attempt, status, progress, started_at, completed_at, created_at, updated_at)
    VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET provider_job_id=excluded.provider_job_id, status=excluded.status,
      progress=excluded.progress, completed_at=excluded.completed_at, updated_at=excluded.updated_at`,
  [`acc-job-${fixture.seriesId.slice(4)}`, assetId, video.uid, ready ? 'ready' : 'processing', ready ? 100 : 50, now, ready ? now : null, now, now]);
  await run(`UPDATE episodes SET active_media_asset_id = CASE WHEN ? THEN ? ELSE active_media_asset_id END, video_status = ?,
    duration_seconds = CASE WHEN ? > 0 THEN ? ELSE duration_seconds END, thumbnail_url = COALESCE(?, thumbnail_url), updated_at = ? WHERE id = ?`,
  [ready ? 1 : 0, assetId, ready ? 'ready' : 'processing', Number(video.duration || 0), Math.round(Number(video.duration || 0)), video.thumbnail || null, now, episodeId]);
}

for (let index = 0; index < categories.length; index += 1) {
  const name = categories[index];
  const id = `acc-cat-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  await run(`INSERT INTO categories (id, name, locale_name, color, sort_order, enabled, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?) ON CONFLICT(name) DO UPDATE SET enabled=1, updated_at=excluded.updated_at, deleted_at=NULL`,
  [id, name, name, ['#d65a67', '#5d6bff', '#2d9d78', '#e18a3b'][index % 4], 10 + index, now, now]);
}
for (let index = 0; index < tags.length; index += 1) {
  const name = tags[index];
  const id = `acc-tag-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  await run(`INSERT INTO tags (id, name, locale_name, color, sort_order, enabled, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?) ON CONFLICT(name) DO UPDATE SET enabled=1, updated_at=excluded.updated_at, deleted_at=NULL`,
  [id, name, name, ['#f05b67', '#4d78e8', '#8256c9'][index % 3], 10 + index, now, now]);
}
for (const item of series) {
  await run('DELETE FROM series_categories WHERE series_id = ?', [item.id]);
  await run('DELETE FROM series_tags WHERE series_id = ?', [item.id]);
  for (let index = 0; index < item.genres.length; index += 1) await run('INSERT INTO series_categories (series_id, category_id, sort_order) SELECT ?, id, ? FROM categories WHERE name = ?', [item.id, index, item.genres[index]]);
  await run('INSERT INTO series_tags (series_id, tag_id, sort_order) SELECT ?, id, 0 FROM tags WHERE name = ?', [item.id, item.badge]);
}

const sections = [
  ['popular', 'Popular now', 'Most watched this week', series.map((item) => item.id)],
  ['new', 'Newly added', 'Recent additions to the acceptance catalogue', [series[4].id, series[2].id, series[3].id, series[1].id, series[0].id]],
  ['animation', 'Animated worlds', 'Open animation from Blender Foundation', [series[0].id, series[1].id, series[3].id, series[4].id]],
  ['fantasy', 'Fantasy journeys', 'Strange worlds and impossible choices', [series[1].id, series[3].id, series[4].id]],
  ['action-scifi', 'Action & sci-fi', 'Technology, conflict and adventure', [series[2].id, series[1].id, series[0].id]],
  ['free-start', 'Free to start', 'Try the first episodes before you unlock the story', series.map((item) => item.id)],
].map(([id, title, subtitle, itemIds]) => ({ id, title, subtitle, enabled: true, count: itemIds.length, source: '手动推荐 + 热度排序', itemIds }));
await run(`INSERT INTO home_config (id, payload, updated_at) VALUES ('home', ?, ?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload, updated_at=excluded.updated_at`, [JSON.stringify(sections), now]);

// Transaction fixtures are opt-in. They are useful for an isolated admin
// acceptance pass, but must never look like a real customer payment in a
// normal deployment. A regular seed also removes any old fixture rows.
if (includeTransactionFixtures) {
await run(`INSERT INTO users (user_id, email, display_name, status, created_at, last_seen_at, updated_at) VALUES (?, ?, 'MVP acceptance fixture', 'active', ?, ?, ?)
  ON CONFLICT(user_id) DO UPDATE SET status='active', updated_at=excluded.updated_at`, [acceptanceUserId, acceptanceEmail, now, now, now]);
await run(`INSERT INTO users (user_id, email, display_name, status, created_at, last_seen_at, updated_at) VALUES (?, ?, 'MVP refund fixture', 'active', ?, ?, ?)
  ON CONFLICT(user_id) DO UPDATE SET status='active', updated_at=excluded.updated_at`, [refundUserId, refundEmail, now, now, now]);
await run("DELETE FROM entitlements WHERE id = 'ent-accept-paid-2026'");
await run("DELETE FROM orders WHERE order_no = 'RN-ACCEPT-PAID-2026'");
await run(`INSERT OR IGNORE INTO orders (order_no, series_id, series_slug, series_title, user_id, email, country, amount_cents, currency, fee_cents, status,
  paypal_order_id, capture_id, note, created_at, updated_at, callback_at, business_idempotency_key, price_version, pricing_snapshot_json, activity_snapshot_json, paypal_environment)
  VALUES ('RN-ACCEPT-PAID-2026', ?, ?, ?, ?, ?, 'US', ?, 'USD', 0, 'paid', 'PAYPAL-ACCEPT-PAID-2026', 'CAPTURE-ACCEPT-PAID-2026', 'MVP acceptance fixture: webhook processed', ?, ?, ?, 'acceptance:paid:2026', 'fixture:1', ?, ?, 'sandbox')`,
  [series[0].id, series[0].slug, series[0].title, acceptanceUserId, acceptanceEmail, series[0].price, now, now, now, JSON.stringify({ seriesId: series[0].id, amountCents: series[0].price, currency: 'USD', priceVersion: 'fixture:1' }), JSON.stringify({ fixture: true })]);
await run(`INSERT INTO entitlements (id, user_id, series_id, order_no, status, granted_at) VALUES ('ent-accept-paid-2026', ?, ?, 'RN-ACCEPT-PAID-2026', 'granted', ?)
  ON CONFLICT(user_id, series_id) DO UPDATE SET order_no=excluded.order_no, status='granted', granted_at=excluded.granted_at, revoked_at=NULL`, [acceptanceUserId, series[0].id, now]);
await run("DELETE FROM refund_events WHERE refund_request_id = 'refund-accept-2026'");
await run("DELETE FROM refund_requests WHERE id = 'refund-accept-2026'");
await run("DELETE FROM entitlements WHERE id = 'ent-accept-refunded-2026'");
await run("DELETE FROM orders WHERE order_no = 'RN-ACCEPT-REFUNDED-2026'");
await run(`INSERT OR IGNORE INTO orders (order_no, series_id, series_slug, series_title, user_id, email, country, amount_cents, currency, fee_cents, status,
  paypal_order_id, capture_id, note, created_at, updated_at, callback_at, business_idempotency_key, price_version, pricing_snapshot_json, activity_snapshot_json, paypal_environment)
  VALUES ('RN-ACCEPT-REFUNDED-2026', ?, ?, ?, ?, ?, 'US', ?, 'USD', 0, 'refunded', 'PAYPAL-ACCEPT-REFUNDED-2026', 'CAPTURE-ACCEPT-REFUNDED-2026', 'MVP acceptance fixture: refund completed and entitlement revoked', ?, ?, ?, 'acceptance:refunded:2026', 'fixture:1', ?, ?, 'sandbox')`,
  [series[0].id, series[0].slug, series[0].title, refundUserId, refundEmail, series[0].price, now, now, now, JSON.stringify({ seriesId: series[0].id, amountCents: series[0].price, currency: 'USD', priceVersion: 'fixture:1' }), JSON.stringify({ fixture: true })]);
await run(`INSERT INTO entitlements (id, user_id, series_id, order_no, status, granted_at, revoked_at)
  VALUES ('ent-accept-refunded-2026', ?, ?, 'RN-ACCEPT-REFUNDED-2026', 'revoked', ?, ?)
  ON CONFLICT(user_id, series_id) DO UPDATE SET order_no=excluded.order_no, status='revoked', revoked_at=excluded.revoked_at`, [refundUserId, series[0].id, now, now]);
await run(`INSERT OR IGNORE INTO refund_requests (id, order_no, capture_id, amount_cents, currency, status, request_source, provider_status, customer_service_result,
  entitlement_revoke_status, reason, requested_by, resolved_by, resolution_note, attempt_count, created_at, updated_at, completed_at)
  VALUES ('refund-accept-2026', 'RN-ACCEPT-REFUNDED-2026', 'CAPTURE-ACCEPT-REFUNDED-2026', ?, 'USD', 'completed', 'manual', 'COMPLETED', 'approved', 'revoked',
  'MVP acceptance refund fixture', ?, ?, 'Fixture refund recorded for acceptance', 1, ?, ?, ?)`, [series[0].price, refundUserId, refundUserId, now, now, now]);

await run(`INSERT INTO watch_history (user_id, series_id, episode_no, position_seconds, duration_seconds, completed, last_event_type, last_watched_at, created_at, updated_at)
  VALUES (?, ?, 1, 92, 161, 0, 'heartbeat', ?, ?, ?)
  ON CONFLICT(user_id, series_id) DO UPDATE SET episode_no=excluded.episode_no, position_seconds=excluded.position_seconds, duration_seconds=excluded.duration_seconds,
    completed=excluded.completed, last_event_type=excluded.last_event_type, last_watched_at=excluded.last_watched_at, updated_at=excluded.updated_at`, [acceptanceUserId, series[0].id, now, now, now]);
} else {
  await run("DELETE FROM refund_events WHERE refund_request_id IN ('refund-accept-2026')");
  await run("DELETE FROM refund_requests WHERE id = 'refund-accept-2026'");
  await run("DELETE FROM entitlements WHERE id IN ('ent-accept-paid-2026', 'ent-accept-refunded-2026')");
  await run("DELETE FROM watch_history WHERE user_id IN ('usr_acceptance_2026', 'usr_acceptance_refund_2026')");
  await run("DELETE FROM orders WHERE order_no IN ('RN-ACCEPT-PAID-2026', 'RN-ACCEPT-REFUNDED-2026')");
  await run("DELETE FROM users WHERE user_id IN ('usr_acceptance_2026', 'usr_acceptance_refund_2026')");
}

console.log(`Seeded ${series.length} acceptance series and ${sections.length} home sections${includeTransactionFixtures ? ', with opt-in transaction fixtures' : ''}.`);
await verify();
