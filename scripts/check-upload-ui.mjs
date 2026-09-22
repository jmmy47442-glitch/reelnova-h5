// Run after npm run build and starting .output/server/index.mjs locally.
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { uploadFlow, videoFixture } from '../tests/helpers/upload-flow.mjs';

const base = process.env.VISUAL_BASE_URL || 'http://127.0.0.1:3014';
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
try {
  for (const scenario of ['fresh', 'cancelled-and-deleted', 'part-retry']) {
    const h = uploadFlow();
    const page = await browser.newPage();
    const file = videoFixture();
    const bytes = [...new Uint8Array(await file.arrayBuffer())];
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    let failParts = scenario === 'part-retry' ? 3 : 0;
    let completed = false;
    const storage = [];
    if (scenario === 'cancelled-and-deleted') {
      const idempotencyKey = `upload:${crypto.randomUUID()}`;
      const session = await h.api.createEpisodeUpload('series-test', {
        idempotencyKey, episodeNo: 1, title: 'Episode 1', fileName: file.name, contentType: file.type, fileSizeBytes: file.size,
      });
      await h.api.cancelEpisodeUpload(session.id);
      await h.managed.deleteManagedEpisodeRecord({}, 'series-test', session.episodeId);
      const key = h.client.resumeKey('series-test', 1, file);
      storage.push([key, JSON.stringify({ session, parts: [{ partNumber: 1, etag: 'stale-part' }] })], [`${key}:idempotency`, idempotencyKey]);
    }
    await page.addInitScript(entries => { for (const [key, value] of entries) localStorage.setItem(key, value); }, storage);
    await page.route('https://media.test/**', async route => {
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: {
        'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,PUT,OPTIONS', 'access-control-allow-headers': '*',
      } });
      if (route.request().method() === 'PUT' && failParts-- > 0) return route.fulfill({ status: 503, headers: { 'access-control-allow-origin': '*' } });
      const request = route.request();
      const response = await h.transport(new Request(request.url(), { method: request.method(), headers: request.headers(), body: request.postDataBuffer() || undefined }));
      await route.fulfill({ status: response.status, headers: { ...Object.fromEntries(response.headers), 'access-control-allow-origin': '*' }, body: Buffer.from(await response.arrayBuffer()) });
    });
    await page.route('**/api/**', async route => {
      const path = new URL(route.request().url()).pathname;
      const body = route.request().postDataJSON();
      let data;
      try {
        if (path.endsWith('/auth/session')) data = { id: 'test-admin', name: 'Test Admin', role: 'super_admin', email: 'test@example.test' };
        else if (path.endsWith('/pending-items')) data = { items: [] };
        else if (path.endsWith('/connection')) {
          await new Promise(resolve => setTimeout(resolve, 1500));
          data = { cloudflare: { database: true, uploadConfigured: true, mediaConfigured: true, mediaWorkerReady: true } };
        }
        else if (path.endsWith('/taxonomy')) data = [];
        else if (path === '/api/admin/series') data = { items: [{ id: 'series-test', slug: 'series-test', title: 'Upload Test', description: '', coverUrl: '/favicon.svg',
          genres: [], episodeCount: completed ? 1 : 0, freeEpisodeCount: 1, price: 0, publishStatus: '草稿', publishAt: '', transcodeProgress: 0, targetRegion: 'Global' }] };
        else if (path.endsWith('/episodes')) data = { items: await h.listEpisodes() };
        else if (path.endsWith('/episodes/uploads')) data = await h.api.createEpisodeUpload('series-test', body);
        else if (/\/uploads\/[^/]+\/progress$/.test(path)) data = await h.api.reportUploadProgress(path.split('/').at(-2), body.uploadedBytes);
        else if (/\/uploads\/[^/]+\/complete$/.test(path)) {
          data = await h.api.completeEpisodeUpload(path.split('/').at(-2), body.parts); completed = data.status === 'ready';
        } else if (/\/uploads\/[^/]+$/.test(path)) data = await h.api.getEpisodeUpload(path.split('/').at(-1));
        else if (path.endsWith('/preview')) data = (await h.preview(path.split('/').at(-2), { format: 'json' })).data;
        else throw new Error(`Unexpected request ${path}`);
        await route.fulfill({ json: { code: 0, data } });
      } catch (error) {
        await route.fulfill({ status: error.statusCode || 500, json: { statusMessage: error.message, data: error.data } });
      }
    });
    await page.route(`${base}/admin/series`, async route => {
      const response = await route.fetch({ url: `${base}/admin/login` });
      await route.fulfill({ response });
    });
    try {
      await page.goto(`${base}/admin/series`);
      await page.getByRole('button', { name: '分集', exact: true }).click();
      await page.locator('#episode-upload-start').fill('1');
      await page.locator('.episode-upload-box input[type=file]').evaluate((input, data) => {
        const transfer = new DataTransfer();
        transfer.items.add(new File([new Uint8Array(data)], 'compatible.mp4', { type: 'video/mp4', lastModified: 1 }));
        input.files = transfer.files; input.dispatchEvent(new Event('change', { bubbles: true }));
      }, bytes);
      await page.getByRole('button', { name: '上传并校验', exact: true }).click();
      if (scenario === 'part-retry') {
        await page.getByText(/分片上传失败.*重新点击/).waitFor();
        await page.getByText('继续上传', { exact: true }).waitFor();
        assert.equal(await page.getByRole('button', { name: '上传并校验', exact: true }).isEnabled(), true);
        await page.getByRole('button', { name: '上传并校验', exact: true }).click();
      }
      await page.getByText('视频已写入 R2 并通过校验，可预览和上架', { exact: true }).waitFor();
      await page.getByRole('button', { name: '发布前预览', exact: true }).click();
      await page.waitForFunction(() => { const v = document.querySelector('.admin-video-preview'); return v?.readyState >= 2 && v.videoWidth > 0; });
      await page.locator('.admin-video-preview').evaluate(video => { video.muted = true; return video.play(); });
      await page.waitForFunction(() => document.querySelector('.admin-video-preview')?.currentTime > 0.1);
      assert.deepEqual(errors, []);
      console.log(`PASS Chrome ${scenario}: file selection → upload → ready → preview decoded and playing`);
    } catch (error) {
      console.error({ scenario, errors, page: (await page.locator('body').innerText()).slice(-3500) });
      throw error;
    } finally { await page.close(); h.db.close(); }
  }
} finally { await browser.close(); }
