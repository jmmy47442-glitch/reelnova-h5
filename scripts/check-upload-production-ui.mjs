// Real browser, production admin APIs, D1 and R2. Requires explicit admin
// credentials in UPLOAD_CHECK_ADMIN_EMAIL / UPLOAD_CHECK_ADMIN_PASSWORD.
// Creates one unpublished draft and removes only its own records and objects.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

const env = process.env;
for (const key of ['UPLOAD_CHECK_ADMIN_EMAIL', 'UPLOAD_CHECK_ADMIN_PASSWORD', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_D1_DATABASE_ID', 'CLOUDFLARE_API_TOKEN']) {
  if (!env[key]) throw new Error(`Missing ${key}`);
}
const base = env.VISUAL_BASE_URL || 'https://admin.iseedrama.com';
const accountBase = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}`;
const headers = { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, 'content-type': 'application/json' };
const query = async (sql, params = []) => {
  const response = await fetch(`${accountBase}/d1/database/${env.CLOUDFLARE_D1_DATABASE_ID}/query`, {
    method: 'POST', headers, body: JSON.stringify({ sql, params }), signal: AbortSignal.timeout(15000),
  });
  const payload = await response.json();
  assert.ok(response.ok && payload.success && payload.result.every(row => row.success), 'Test D1 query failed');
  return payload.result[0].results;
};
const browser = await chromium.launch({ executablePath: env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
page.on('requestfailed', request => console.log(`Browser request failed: ${new URL(request.url()).pathname}: ${request.failure()?.errorText}`));
page.on('response', async response => {
  if (response.url().endsWith('/api/admin/connection')) {
    const payload = await response.json().catch(() => ({}));
    console.log('Browser upload readiness:', response.status(), JSON.stringify(payload.data?.cloudflare));
  }
});
let seriesId;
try {
  await page.goto(`${base}/admin/login`);
  await page.locator('input[type=email]').fill(env.UPLOAD_CHECK_ADMIN_EMAIL);
  await page.locator('input[autocomplete=current-password]').fill(env.UPLOAD_CHECK_ADMIN_PASSWORD);
  await page.getByRole('button', { name: '登录工作台', exact: true }).click();
  await page.waitForURL(url => url.pathname === '/admin');
  if (env.UPLOAD_CHECK_SERIES_ID) {
    const rows = await query("SELECT id FROM series WHERE id = ? AND title LIKE 'Upload browser check %' AND status = 'draft'", [env.UPLOAD_CHECK_SERIES_ID]);
    assert.equal(rows.length, 1, 'Temporary test draft not found');
    seriesId = rows[0].id;
  } else {
    const title = `Upload browser check ${crypto.randomUUID()}`;
    const created = await page.request.post(`${base}/api/admin/series`, { data: {
      title, description: 'Temporary upload verification', genres: ['Drama'], targetRegion: 'Global', freeEpisodeCount: 2, price: 0,
    } });
    assert.equal(created.status(), 200);
    seriesId = (await created.json()).data.id;
  }
  console.log(`Temporary production series: ${seriesId}`);
  await page.goto(`${base}/admin/series`);
  await page.getByPlaceholder('搜索剧名、ID 或 slug').fill(seriesId);
  await page.getByRole('button', { name: '分集', exact: true }).click();
  const small = readFileSync(new URL('../tests/fixtures/media/compatible.mp4', import.meta.url));
  const freeBox = Buffer.alloc(11 * 1024 * 1024);
  freeBox.writeUInt32BE(freeBox.length, 0); freeBox.write('free', 4);
  for (const [index, buffer] of [small, Buffer.concat([small, freeBox])].entries()) {
    await page.waitForFunction(() => [...document.querySelectorAll('.admin-episode-drawer button')].some(button => button.textContent === '选择视频' && !button.disabled));
    await page.locator('#episode-upload-start').fill(String(index + 1));
    await page.locator('#episode-upload-start').blur();
    await page.locator('.episode-upload-box input[type=file]').setInputFiles({ name: `browser-${index + 1}.mp4`, mimeType: 'video/mp4', buffer });
    const completion = page.waitForResponse(response => response.url().endsWith('/complete') && response.request().method() === 'POST', { timeout: 120000 });
    await page.getByRole('button', { name: '上传并校验', exact: true }).click();
    const result = await completion;
    assert.equal(result.status(), 200);
    assert.equal((await result.json()).data.status, 'ready');
    const rows = await (await page.request.get(`${base}/api/admin/series/${seriesId}/episodes`)).json();
    const episode = rows.data.items.find(row => row.episodeNo === index + 1);
    assert.equal(episode.videoStatus, 'ready');
    const preview = await (await page.request.get(`${base}/api/admin/media/${episode.mediaAssetId}/preview?format=json`)).json();
    assert.equal(preview.data.delivery, 'mp4');
    const bytes = await page.request.get(preview.data.url);
    assert.deepEqual(await bytes.body(), buffer);
    await page.getByRole('button', { name: '发布前预览', exact: true }).nth(index).click();
    await page.waitForFunction(() => { const video = document.querySelector('.admin-video-preview'); return video?.readyState >= 2 && video.videoWidth > 0; });
    await page.locator('.admin-video-preview').evaluate(video => { video.muted = true; return video.play(); });
    await page.waitForFunction(() => document.querySelector('.admin-video-preview')?.currentTime > 0.1);
    await page.locator('.el-dialog').filter({ has: page.locator('.admin-video-preview') }).getByRole('button', { name: 'Close this dialog' }).click();
    console.log(`PASS production Chrome ${buffer.length} bytes: file selection → multipart → complete → D1 ready → signed preview → decoded playback`);
  }
  assert.deepEqual(errors, []);
} catch (error) {
  console.error({ errors, page: (await page.locator('.admin-episode-drawer').innerText().catch(() => '')).slice(-2500) });
  throw error;
} finally {
  await browser.close();
  if (seriesId) {
    const rows = await query(`SELECT s.* FROM media_upload_sessions s JOIN media_assets a ON a.id = s.media_asset_id
      JOIN episodes e ON e.id = a.episode_id WHERE e.series_id = ?`, [seriesId]);
    // Do not erase evidence or interrupt an unfinished upload after a failure.
    if (rows.length && rows.every(row => row.status === 'completed')) {
      for (const row of rows) {
        const etag = encodeURIComponent(`"${row.source_etag.replace(/^"|"$/g, '')}"`);
        const keys = [row.object_key, `_reelnova/upload-sessions/${row.idempotency_key}.json`,
          `validation/${row.media_asset_id}/${etag}.json`, `validation/playback-v2/${row.media_asset_id}/${etag}.json`];
        for (const key of keys) {
          const response = await fetch(`${accountBase}/r2/buckets/reelnova-media-private/objects/${key.split('/').map(encodeURIComponent).join('/')}`, { method: 'DELETE', headers, signal: AbortSignal.timeout(15000) });
          assert.ok(response.ok || response.status === 404, 'Test R2 cleanup failed');
        }
      }
      await query('UPDATE episodes SET active_media_asset_id = NULL WHERE series_id = ?', [seriesId]);
      for (const row of rows) {
        await query('DELETE FROM media_upload_sessions WHERE id = ?', [row.id]);
        await query('DELETE FROM transcode_jobs WHERE media_asset_id = ?', [row.media_asset_id]);
        await query('DELETE FROM media_assets WHERE id = ?', [row.media_asset_id]);
      }
      await query('DELETE FROM episodes WHERE series_id = ?', [seriesId]);
      await query('DELETE FROM series_categories WHERE series_id = ?', [seriesId]);
      await query('DELETE FROM series_tags WHERE series_id = ?', [seriesId]);
      await query('DELETE FROM series WHERE id = ?', [seriesId]);
      console.log('PASS temporary production test data removed; administrator audit entries retained');
    } else console.log(`Test records retained: ${seriesId}`);
  }
}
