import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const base = process.env.VISUAL_BASE_URL || 'http://127.0.0.1:3107';
const directory = process.env.HLS_FIXTURE_DIR;
const originalFile = process.env.HLS_ORIGINAL_FIXTURE;
if (!directory || !originalFile) throw new Error('Set HLS_FIXTURE_DIR to a 1080P HLS package and HLS_ORIGINAL_FIXTURE to its source MP4 (at least 12 seconds).');
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
try {
  for (const withOriginal of [false, true]) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [], requests = [];
    page.on('pageerror', error => errors.push(error.message));
    try {
      await page.route('**/api/**', route => {
        const path = new URL(route.request().url()).pathname;
        if (!path.startsWith('/api/')) return route.continue();
        let data = {};
        if (path.endsWith('/auth/session')) data = { userId: 'quality-check', name: 'Quality Check' };
        else if (path.includes('/series/')) data = { id: 'quality-check', slug: 'quality-check', title: 'Quality check',
          episodeCount: 1, freeEpisodeCount: 1, price: 0, genres: [], cast: [],
          episodes: [{ id: 'episode-1', episodeNo: 1, title: 'Episode', duration: '0:12', isFree: true }] };
        else if (path.endsWith('/playback')) data = { authorized: true, delivery: 'hls',
          signedUrl: `${base}/quality-fixture/master.m3u8`,
          originalUrl: withOriginal ? `${base}/quality-fixture/original.mp4` : undefined,
          trackingToken: 'test', expiresAt: new Date(Date.now() + 600000).toISOString() };
        return route.fulfill({ json: { data } });
      });
      await page.route('**/quality-fixture/**', route => {
        const file = new URL(route.request().url()).pathname.split('/quality-fixture/')[1];
        assert.match(file, /^(original\.mp4|master\.m3u8|v(?:360|480|720|1080)\/(index\.m3u8|init\.mp4|seg-\d{6}\.m4s))$/);
        requests.push(file);
        const bytes = readFileSync(file === 'original.mp4' ? originalFile : join(directory, file));
        const range = /^bytes=(\d+)-(\d*)$/.exec(route.request().headers().range || '');
        const start = range ? Number(range[1]) : 0;
        const end = range?.[2] ? Math.min(Number(range[2]), bytes.length - 1) : bytes.length - 1;
        const body = bytes.subarray(start, end + 1);
        return route.fulfill({ status: range ? 206 : 200, body,
          contentType: file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp4',
          headers: { 'content-length': String(body.length), 'accept-ranges': 'bytes',
            ...(range ? { 'content-range': `bytes ${start}-${end}/${bytes.length}` } : {}) } });
      });
      await page.goto(`${base}/terms`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => document.querySelector('#__nuxt')?.__vue_app__?.config.globalProperties.$router);
      await page.evaluate(() => document.querySelector('#__nuxt').__vue_app__.config.globalProperties.$router.push('/watch/quality-check/1'));
      const quality = page.getByRole('button', { name: 'Video quality', exact: true });
      await quality.click();
      await page.getByRole('button', { name: '1080P High definition', exact: true }).waitFor();
      await page.getByRole('button', { name: withOriginal ? '1080P High definition' : 'Highest Highest available quality', exact: true }).click();
      await page.getByRole('button', { name: 'Play', exact: true }).click();
      await page.waitForFunction(() => {
        const media = document.querySelector('video');
        return media?.videoHeight === 1080 && media.currentTime > 0.5 && !media.paused;
      });
      assert.ok(requests.some(file => /^v1080\/seg-/.test(file)));
      assert.match(await quality.innerText(), /1080P/);
      if (withOriginal) {
        const position = await page.locator('video').evaluate(media => { media.pause(); return media.currentTime; });
        await quality.click();
        await page.getByRole('button', { name: 'Original Source quality', exact: true }).click();
        await page.waitForFunction(position => {
          const media = document.querySelector('video');
          return media?.currentSrc.endsWith('/original.mp4') && media.readyState >= 2
            && media.videoHeight === 1080 && Math.abs(media.currentTime - position) < 0.3;
        }, position);
        assert.equal(await page.locator('video').evaluate(media => media.paused), true);
        assert.match(await quality.innerText(), /Original/);
        await quality.click();
        await page.getByRole('button', { name: 'Auto Adjusts to your connection', exact: true }).click();
        await page.waitForFunction(position => {
          const media = document.querySelector('video');
          return media?.currentSrc.startsWith('blob:') && media.readyState >= 2 && Math.abs(media.currentTime - position) < 0.3;
        }, position);
        await page.getByRole('button', { name: 'Play', exact: true }).click();
        await page.waitForFunction(position => document.querySelector('video')?.currentTime > position + 0.5, position);
        assert.match(await quality.innerText(), /Auto/);
      }
      assert.deepEqual(errors, []);
      console.log(withOriginal ? '1080P → Original → Auto passed, including decoded resolution and position preservation.' : 'Highest selected and decoded the actual 1080P rendition.');
    } catch (error) {
      console.error({ withOriginal, errors, requests });
      throw error;
    } finally { await page.close(); }
  }
} finally { await browser.close(); }
