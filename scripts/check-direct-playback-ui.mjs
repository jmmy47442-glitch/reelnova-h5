import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

const base = process.env.VISUAL_BASE_URL || 'http://127.0.0.1:3107';
const bytes = readFileSync(new URL('../tests/fixtures/media/compatible.mp4', import.meta.url));
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errors = [], mediaRequests = [];
let grants = 0;
page.on('pageerror', error => errors.push(error.message));
const series = { id: 'direct-check', slug: 'direct-check', title: 'MP4 playback check',
  backdropUrl: '/posters/vows-vengeance-wide.jpg', coverUrl: '/posters/vows-vengeance.jpg',
  episodeCount: 1, freeEpisodeCount: 1, price: 0, genres: [], cast: [],
  episodes: [{ id: 'episode-1', episodeNo: 1, title: 'Episode', duration: '0:12', isFree: true }] };
try {
  // All business calls are intercepted, including analytics and watch history.
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (!path.startsWith('/api/')) return route.continue();
    let data = {};
    if (path.endsWith('/auth/session')) data = { userId: 'direct-check', name: 'MP4 Check' };
    else if (path.includes('/series/')) data = series;
    else if (path.endsWith('/playback')) {
      grants++;
      const url = `${base}/test-source.mp4?grant=${grants}`;
      data = { authorized: true, signedUrl: url, originalUrl: url, delivery: 'mp4', trackingToken: 'test',
        expiresAt: new Date(Date.now() + 61000).toISOString(), resumePositionSeconds: 4, resumeDurationSeconds: 12 };
    }
    return route.fulfill({ json: { data } });
  });
  await page.route('**/test-source.mp4?*', route => {
    mediaRequests.push(route.request().resourceType());
    const range = /bytes=(\d+)-(\d*)/.exec(route.request().headers().range || '');
    const start = Number(range?.[1] || 0), end = range?.[2] ? Math.min(Number(range[2]), bytes.length - 1) : bytes.length - 1;
    return route.fulfill({ status: range ? 206 : 200, contentType: 'video/mp4', body: bytes.subarray(start, end + 1),
      headers: { 'accept-ranges': 'bytes', 'content-length': String(end - start + 1), ...(range ? { 'content-range': `bytes ${start}-${end}/${bytes.length}` } : {}) } });
  });
  await page.goto(`${base}/terms`);
  await page.waitForFunction(() => document.querySelector('#__nuxt')?.__vue_app__?.config.globalProperties.$router);
  await page.evaluate(() => document.querySelector('#__nuxt').__vue_app__.config.globalProperties.$router.push('/watch/direct-check/1'));
  await page.getByRole('button', { name: 'Continue from 0:04' }).click();
  await page.waitForFunction(() => { const video = document.querySelector('video'); return video?.currentTime >= 4 && video.readyState >= 2 && !video.paused; });
  await page.locator('video').evaluate(video => video.pause());
  const quality = page.getByRole('button', { name: 'Video quality', exact: true });
  assert.equal(await quality.isDisabled(), true);
  assert.match(await quality.innerText(), /Original/);
  await page.getByRole('slider', { name: 'Seek', exact: true }).fill('50');
  await page.waitForFunction(() => Math.abs(document.querySelector('video').currentTime - 6) < 0.3);
  await page.waitForFunction(() => document.querySelector('video')?.currentSrc.includes('grant=2'), { }, { timeout: 22000 });
  await page.waitForFunction(() => Math.abs(document.querySelector('video').currentTime - 6) < 0.3 && document.querySelector('video').readyState >= 2);
  assert.ok(grants >= 2, 'renewal should request a fresh playback authorization');
  assert.ok(mediaRequests.length >= 2);
  assert.ok(mediaRequests.every(type => type === 'media'), 'MP4 must never be fetched as an HLS manifest');
  assert.deepEqual(errors, []);
  console.log('MP4 browser checks passed: decoding, resume at 4s, seek to 6s, signed URL renewal retains position, fixed Original quality, no manifest requests.');
} catch (error) {
  console.error({ url: page.url(), grants, errors, mediaRequests });
  throw error;
} finally { await browser.close(); }
