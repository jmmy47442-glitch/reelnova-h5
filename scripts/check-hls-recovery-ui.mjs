import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const base = process.env.VISUAL_BASE_URL || 'http://127.0.0.1:3107';
const directory = process.env.HLS_FIXTURE_DIR;
if (!directory) throw new Error('Set HLS_FIXTURE_DIR to an HLS fixture with v360 and v720 renditions.');
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });

try {
  for (const slow of [false, true]) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const requests = [], errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/**', route => {
      const path = new URL(route.request().url()).pathname;
      if (!path.startsWith('/api/')) return route.continue();
      let data = {};
      if (path.endsWith('/auth/session')) data = { userId: 'recovery-check', name: 'Recovery Check' };
      else if (path.includes('/series/')) data = { id: 'recovery-check', slug: 'recovery-check', title: 'Playback recovery',
        episodeCount: 1, freeEpisodeCount: 1, price: 0, genres: [], cast: [],
        episodes: [{ id: 'episode-1', episodeNo: 1, title: 'Episode', duration: '0:12', isFree: true }] };
      else if (path.endsWith('/playback')) data = { authorized: true, delivery: 'hls',
        signedUrl: `${base}/recovery-fixture/master.m3u8`, trackingToken: 'test',
        expiresAt: new Date(Date.now() + 600000).toISOString(), resumePositionSeconds: 0 };
      return route.fulfill({ json: { data } });
    });
    await page.route('**/recovery-fixture/**', async route => {
      const file = new URL(route.request().url()).pathname.split('/recovery-fixture/')[1];
      assert.match(file, /^(master\.m3u8|v(?:360|480|720|1080)\/(index\.m3u8|init\.mp4|seg-\d{6}\.m4s))$/);
      requests.push({ file, time: Date.now() });
      // Keep lower levels fast so this check can prove a stalled fixed-quality
      // request is not silently replaced by another rendition.
      if (file.endsWith('.m4s')) await new Promise(resolve => setTimeout(resolve, slow && file.startsWith('v720/') ? 15000 : 150));
      await route.fulfill({ body: readFileSync(join(directory, file)),
        contentType: file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp4' }).catch(() => {});
    });
    try {
      await page.goto(`${base}/terms`);
      await page.waitForFunction(() => document.querySelector('#__nuxt')?.__vue_app__?.config.globalProperties.$router);
      await page.evaluate(() => document.querySelector('#__nuxt').__vue_app__.config.globalProperties.$router.push('/watch/recovery-check/1'));
      const quality = page.getByRole('button', { name: 'Video quality', exact: true });
      await quality.click();
      await page.getByRole('button', { name: '720P High definition', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('video')?.readyState >= 2);
      await page.waitForTimeout(4200);
      assert.match(await quality.innerText(), /720P/, 'paused preloading must not override a manual choice');
      assert.ok(requests.some(request => request.file.startsWith('v720/') && request.file.endsWith('.m4s')));
      await page.getByRole('button', { name: 'Play', exact: true }).click();
      const playAt = Date.now();
      await page.waitForFunction(() => document.querySelector('video')?.currentTime > 5, {}, { timeout: slow ? 25000 : 10000 });
      assert.match(await quality.innerText(), /720P/, 'network conditions must not override a manual choice');
      assert.equal(await page.locator('.watch-quality-notice').count(), 0);
      if (slow) assert.equal(requests.some(request => /^v(?:360|480)\/.+\.m4s$/.test(request.file) && request.time >= playAt), false);
      assert.deepEqual(errors, []);
      console.log(`${slow ? 'Slow' : 'Fast'} network passed: fixed 720P retained, paused preloading respected.`);
    } catch (error) {
      console.error({ slow, errors, requests });
      throw error;
    } finally { await page.close(); }
  }
} finally { await browser.close(); }
