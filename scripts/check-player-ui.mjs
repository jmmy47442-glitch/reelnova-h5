import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const baseURL = process.env.VISUAL_BASE_URL || 'http://127.0.0.1:3000';
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const series = {
  id: 'player-check', slug: 'player-check', title: 'Player interaction check',
  backdropUrl: '/posters/vows-vengeance-wide.jpg', coverUrl: '/posters/vows-vengeance-wide.jpg',
  episodeCount: 2, freeEpisodeCount: 2, price: 0, genres: [], cast: [],
  episodes: [1, 2].map(episodeNo => ({ id: `episode-${episodeNo}`, episodeNo, title: 'Episode', duration: '1:00', isFree: true })),
};

try {
  // Isolate UI checks from real accounts, playback grants, and analytics writes.
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (!path.startsWith('/api/')) return route.continue();
    const data = path.endsWith('/auth/session') ? { userId: 'player-check', name: 'UI Check' }
      : path.includes('/series/') ? series
      : path.endsWith('/playback') ? { signedUrl: `${baseURL}/player-check.m3u8`, trackingToken: 'ui-check' }
      : {};
    return route.fulfill({ json: { data } });
  });
  await page.route('**/player-check.m3u8', route => route.fulfill({ contentType: 'application/vnd.apple.mpegurl', body: '#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXT-X-ENDLIST\n' }));
  await page.goto(`${baseURL}/terms`);
  await page.waitForFunction(() => window.useNuxtApp && !window.useNuxtApp().isHydrating);
  await page.evaluate(() => document.querySelector('#__nuxt').__vue_app__.config.globalProperties.$router.push('/watch/player-check/1'));
  const trigger = page.getByRole('button', { name: 'Volume controls', exact: true });
  await trigger.waitFor();
  for (const name of ['Captions', 'Share', 'More']) assert.equal(await page.getByRole('button', { name, exact: true }).count(), 0);

  await trigger.click();
  const slider = page.getByRole('slider', { name: 'Volume', exact: true });
  await slider.fill('40');
  assert.equal(await page.locator('video').evaluate(video => video.volume), 0.4);
  await slider.focus();
  await page.keyboard.press('ArrowUp');
  assert.equal(await slider.inputValue(), '41');
  await page.getByRole('button', { name: 'Mute', exact: true }).click();
  assert.equal(await page.locator('video').evaluate(video => video.muted), true);
  await page.getByRole('button', { name: 'Unmute', exact: true }).click();
  assert.equal(await page.locator('video').evaluate(video => video.muted), false);
  await page.keyboard.press('Escape');
  assert.equal(await slider.count(), 0);

  // Pointer capture must keep adjusting after dragging outside the small button.
  const bounds = await trigger.boundingBox();
  const x = bounds.x + bounds.width / 2;
  const y = bounds.y + bounds.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y - 56, { steps: 8 });
  await page.mouse.up();
  assert.equal(await slider.inputValue(), '81');
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + 14, { steps: 4 });
  await page.mouse.up();
  assert.equal(await slider.inputValue(), '71');

  await mkdir('artifacts/screenshots', { recursive: true });
  await page.screenshot({ path: 'artifacts/screenshots/h5-player-volume-390.png' });
  await page.getByRole('button', { name: 'Fullscreen', exact: true }).click();
  await page.waitForFunction(() => document.fullscreenElement?.classList.contains('watch-page'));
  await page.getByRole('button', { name: 'Exit fullscreen', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Exit fullscreen', exact: true }).click();
  await page.waitForFunction(() => !document.fullscreenElement);

  for (const viewport of [{ width: 375, height: 667 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(viewport);
    await trigger.click();
    const panel = await page.locator('.watch-volume__panel').boundingBox();
    assert.ok(panel.y >= 0 && panel.x >= 0 && panel.x + panel.width <= viewport.width);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: `artifacts/screenshots/h5-player-volume-${viewport.width}.png` });
    await page.keyboard.press('Escape');
  }

  // Simulate iPhone's API surface; physical native fullscreen still needs a device check.
  await page.locator('.watch-page').evaluate(player => { player.requestFullscreen = undefined; });
  await page.locator('video').evaluate(video => {
    video.webkitEnterFullscreen = function () { this.dataset.nativeFullscreen = 'entered'; };
  });
  await page.getByRole('button', { name: 'Fullscreen', exact: true }).click();
  assert.equal(await page.locator('video').getAttribute('data-native-fullscreen'), 'entered');
  await page.locator('.watch-page').evaluate(player => { player.requestFullscreen = () => Promise.reject(new Error('Blocked')); });
  await page.locator('video').evaluate(video => { delete video.dataset.nativeFullscreen; });
  await page.getByRole('button', { name: 'Fullscreen', exact: true }).click();
  assert.equal(await page.locator('video').getAttribute('data-native-fullscreen'), 'entered');
  await page.locator('video').evaluate(video => { video.webkitEnterFullscreen = undefined; video.webkitEnterFullScreen = undefined; });
  await page.locator('.watch-page').evaluate(player => { player.webkitRequestFullscreen = undefined; });
  await page.getByRole('button', { name: 'Fullscreen', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Fullscreen could not open' }).waitFor();

  // A browser that ignores programmatic volume must not display a fictitious percentage.
  await page.locator('video').evaluate(video => { Object.defineProperty(video, 'volume', { configurable: true, get: () => 1, set: () => {} }); });
  await trigger.click();
  await slider.fill('30');
  await page.getByText('Use your device volume buttons to adjust the sound.').waitFor();
  assert.equal(await slider.count(), 0);
  assert.deepEqual(errors, []);
  console.log('Player checks passed: controls removed, volume drag/slider/mute/keyboard, responsive layout, fullscreen enter/exit, iPhone fallback and unsupported-browser feedback.');
} catch (error) {
  console.error({ url: page.url(), errors });
  throw error;
} finally {
  await browser.close();
}
