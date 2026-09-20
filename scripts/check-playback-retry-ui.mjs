import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const base = process.env.VISUAL_BASE_URL || 'http://127.0.0.1:3107';
const directory = process.env.HLS_FIXTURE_DIR;
if (!directory) throw new Error('Set HLS_FIXTURE_DIR to an HLS package with v360, v480 and v720 renditions.');
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
try {
  for (const scenario of ['manifest', 'renewal', 'mp4']) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    let grants = 0;
    let failAuthorization = false;
    let failManifest = scenario === 'manifest';
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/**', route => {
      const path = new URL(route.request().url()).pathname;
      if (!path.startsWith('/api/')) return route.continue();
      let data = {};
      if (path.endsWith('/auth/session')) data = { userId: 'retry-check', name: 'Retry Check' };
      else if (path.includes('/series/')) data = { id: 'retry-check', slug: 'retry-check', title: 'Playback retry',
        episodeCount: 1, freeEpisodeCount: 1, price: 0, genres: [], cast: [],
        episodes: [{ id: 'episode-1', episodeNo: 1, title: 'Episode', duration: '0:12', isFree: true }] };
      else if (path.endsWith('/playback')) {
        grants++;
        if (failAuthorization) return route.fulfill({ status: 503, json: { message: 'Offline' } });
        // A server can issue the same URL again within its signing window.
        const source = `${base}/retry-fixture/grant-${scenario === 'manifest' ? 1 : grants}/${scenario === 'mp4' ? 'source.mp4' : 'master.m3u8'}`;
        data = { authorized: true, delivery: scenario === 'mp4' ? 'mp4' : 'hls', signedUrl: source, originalUrl: scenario === 'mp4' ? source : undefined,
          trackingToken: 'test', expiresAt: new Date(Date.now() + 600000).toISOString(),
          resumePositionSeconds: scenario !== 'manifest' ? 2 : 0, resumeDurationSeconds: 12 };
      }
      return route.fulfill({ json: { data } });
    });
    await page.route('**/retry-fixture/**', route => {
      const file = new URL(route.request().url()).pathname.replace(/^\/retry-fixture\/grant-\d+\//, '');
      if (file === 'source.mp4') {
        const bytes = readFileSync(new URL('../tests/fixtures/media/compatible.mp4', import.meta.url));
        const range = /bytes=(\d+)-(\d*)/.exec(route.request().headers().range || '');
        const start = Number(range?.[1] || 0);
        const end = range?.[2] ? Math.min(Number(range[2]), bytes.length - 1) : bytes.length - 1;
        return route.fulfill({ status: range ? 206 : 200, body: bytes.subarray(start, end + 1), contentType: 'video/mp4',
          headers: { 'accept-ranges': 'bytes', 'content-length': String(end - start + 1),
            ...(range ? { 'content-range': `bytes ${start}-${end}/${bytes.length}` } : {}) } });
      }
      assert.match(file, /^(master\.m3u8|v(?:360|480|720|1080)\/(index\.m3u8|init\.mp4|seg-\d{6}\.m4s))$/);
      if (failManifest && file === 'master.m3u8') return route.fulfill({ status: 403, body: 'Expired' });
      return route.fulfill({ body: readFileSync(join(directory, file)),
        contentType: file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp4' });
    });
    try {
      await page.goto(`${base}/terms`);
      await page.waitForFunction(() => document.querySelector('#__nuxt')?.__vue_app__?.config.globalProperties.$router);
      await page.evaluate(() => document.querySelector('#__nuxt').__vue_app__.config.globalProperties.$router.push('/watch/retry-check/1'));
      let interruptedAt = 0;
      if (scenario !== 'manifest') {
        await page.getByRole('button', { name: 'Continue from 0:02' }).click();
        await page.waitForFunction(() => document.querySelector('video')?.currentTime > 4);
        await page.getByRole('button', { name: 'Playback speed' }).click();
        failAuthorization = true;
        // Invoke the same callback as the renewal timer without waiting ten minutes.
        await page.locator('video').evaluate(video => video.__vueParentComponent.setupState.authorize(true));
        interruptedAt = await page.locator('video').evaluate(video => video.currentTime);
        assert.ok(await page.locator('video').evaluate(video => video.paused), 'failed renewal must stop obsolete playback behind the error');
      }
      const retry = page.getByRole('button', { name: 'Retry playback', exact: true });
      await retry.waitFor({ timeout: 15000 });
      failAuthorization = true;
      await retry.click();
      await retry.waitFor({ timeout: 15000 });
      assert.equal(await page.getByRole('heading', { name: 'Continue watching?' }).count(), 0);
      failAuthorization = false;
      failManifest = false;
      const grantsBefore = grants;
      await page.locator('video').evaluate(video => {
        window.retryResumedAt = undefined;
        video.addEventListener('playing', () => { window.retryResumedAt = video.currentTime; }, { once: true });
      });
      await retry.click();
      await page.waitForFunction(position => {
        const video = document.querySelector('video');
        return video && !video.paused && video.currentTime > position + 0.5;
      }, interruptedAt, { timeout: 15000 });
      assert.equal(grants, grantsBefore + 1, 'one retry requests one fresh grant');
      assert.equal(await retry.count(), 0);
      assert.equal(await page.getByRole('heading', { name: 'Continue watching?' }).count(), 0);
      const resumedAt = await page.evaluate(() => window.retryResumedAt);
      assert.ok(Math.abs(resumedAt - interruptedAt) < 0.5, `must resume at interruption (${interruptedAt}), not old history or zero (${resumedAt})`);
      if (scenario !== 'manifest') {
        assert.equal(await page.locator('video').evaluate(video => video.playbackRate), 1.25, 'retry retains playback speed');
      }
      assert.deepEqual(errors, []);
      console.log(`${scenario}: failed retry stays actionable; successful retry gets a fresh URL and resumes playback.`);
    } finally { await page.close(); }
  }
} finally { await browser.close(); }
