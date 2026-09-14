import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const baseURL = process.env.VISUAL_BASE_URL || 'http://127.0.0.1:3005';
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
await mkdir('artifacts/screenshots', { recursive: true });
try {
  for (const width of [1440, 375]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const errors = [];
    const submissions = [];
    let failSubmission = true;
    let empty = false;
    let adminFilter;
    const order = { orderNo: 'RN-20260914-PURCHASE', seriesId: 's', seriesTitle: 'Vows and Vengeance', amount: 9.99, currency: 'USD', status: 'paid', entitlementStatus: 'granted', createdAt: '2026-09-14T10:00:00Z', paymentMethod: 'paypal' };
    const series = { id: 's', slug: 'vows-and-vengeance', title: order.seriesTitle, coverUrl: '/posters/vows-vengeance.jpg', episodeCount: 60 };
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error') console.log(message.text()); });
    page.on('requestfailed', (request) => console.log('Request failed:', request.url(), request.failure()));
    await page.addInitScript(() => localStorage.setItem('reelnova-theme', 'light'));
    await page.route('**/api/**', async (route) => {
      const url = new URL(route.request().url());
      const path = url.pathname;
      if (!path.startsWith('/api/')) return route.continue();
      let data;
      if (path.endsWith('/auth/session')) data = path.startsWith('/api/admin') ? { id: 'admin', name: 'Admin', email: 'admin@example.com', role: 'super_admin' } : { userId: 'u', name: 'Test Customer', email: 'customer@example.com' };
      else if (path === '/api/me/settings') data = { language: 'en', recommendations: true, analytics: true, marketing: false };
      else if (path === '/api/me/library') data = { continueWatching: [], purchased: empty ? [] : [series] };
      else if (path === '/api/me/orders') data = empty ? [] : [order, { ...order, orderNo: 'RN-REFUNDED', seriesId: 'old', seriesTitle: 'Previously refunded story', status: 'refunded', refundStatus: 'completed', entitlementStatus: 'revoked' }];
      else if (path === `/api/me/orders/${order.orderNo}/refund`) {
        submissions.push(route.request().postDataJSON());
        if (failSubmission) return route.fulfill({ status: 503, json: { statusMessage: 'Temporarily unavailable. Try again.' } });
        order.refundStatus = 'pending';
        data = { orderNo: order.orderNo, refundStatus: 'pending' };
      } else if (path === '/api/admin/orders') {
        adminFilter = url.searchParams.get('refundStatus');
        data = { connected: true, generatedAt: new Date().toISOString(), total: 1, summary: { todayOrders: 1, paidAmount: 9.99, pending: 0, exceptions: 0 }, items: [{ ...order, email: 'payer@example.com', country: 'US', fee: 0.4, netAmount: 9.59, entitlement: 'granted', refund: { status: 'pending', amount: 9.99, customerRequest: { userId: 'u', name: 'Test Customer', email: 'customer@example.com', reason: 'I purchased the wrong story', createdAt: order.createdAt } } }] };
      } else if (path.endsWith('/pending-items')) data = { items: [], total: 0 };
      else return route.fulfill({ status: 404, json: { message: `Unexpected mock: ${path}` } });
      await route.fulfill({ json: { data } });
    });
    await page.route((url) => url.origin === baseURL && (url.pathname.startsWith('/profile') || url.pathname === '/admin/orders'), async (route) => {
      const response = await route.fetch({ url: `${baseURL}/admin/login` });
      await route.fulfill({ response });
    });
    await page.goto(`${baseURL}/profile`);
    await page.getByRole('heading', { name: 'Test Customer' }).waitFor({ timeout: 15000 }).catch(async (error) => {
      console.log({ url: page.url(), errors, body: await page.locator('body').innerText() });
      throw error;
    });
    assert.equal(await page.locator('.restore-panel, input').count(), 0);
    await page.screenshot({ path: `artifacts/screenshots/profile-no-restore-${width}.png` });
    await page.getByRole('link', { name: 'My purchases', exact: true }).click();
    const requestButton = page.getByRole('button', { name: 'Request refund', exact: true });
    await requestButton.waitFor();
    assert.equal(await requestButton.count(), 1);
    await page.screenshot({ path: `artifacts/screenshots/purchase-refund-${width}.png` });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.equal(await page.locator('.purchase-row img').evaluate((image) => image.complete && image.naturalWidth > 0), true);
    await requestButton.click();
    const dialog = page.getByRole('dialog', { name: 'Request refund' });
    await dialog.getByRole('textbox', { name: 'Refund reason' }).fill('short');
    await dialog.getByRole('button', { name: 'Submit request' }).click();
    await dialog.getByRole('alert').waitFor();
    assert.equal(submissions.length, 0);
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    await requestButton.click();
    await dialog.getByRole('textbox', { name: 'Refund reason' }).fill('I purchased the wrong story');
    await dialog.getByRole('button', { name: 'Submit request' }).click();
    await dialog.getByText('Temporarily unavailable. Try again.').waitFor();
    await page.screenshot({ path: `artifacts/screenshots/purchase-refund-dialog-${width}.png` });
    const bounds = await dialog.boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width && bounds.y >= 0 && bounds.y + bounds.height <= 900);
    failSubmission = false;
    await dialog.getByRole('button', { name: 'Submit request' }).click();
    await dialog.waitFor({ state: 'hidden' });
    await page.getByText('Refund requested', { exact: true }).waitFor();
    assert.deepEqual(submissions.at(-1), { reason: 'I purchased the wrong story' });
    assert.equal(await requestButton.count(), 0);
    await page.reload();
    await page.getByText('Refund requested', { exact: true }).waitFor();
    empty = true;
    await page.getByRole('button', { name: 'Refresh page data' }).click();
    await page.getByRole('heading', { name: 'No purchases yet' }).waitFor();
    assert.equal(await requestButton.count(), 0);
    await page.goto(`${baseURL}/admin/orders?refundStatus=pending`);
    await page.getByRole('button', { name: '详情', exact: true }).waitFor();
    assert.equal(adminFilter, 'pending');
    await page.getByRole('button', { name: '详情', exact: true }).click();
    const drawer = page.getByRole('dialog', { name: '订单详情' });
    await drawer.getByText('I purchased the wrong story', { exact: true }).waitFor();
    assert.match(await drawer.innerText(), /customer@example.com/);
    await page.screenshot({ path: `artifacts/screenshots/customer-refund-admin-${width}.png` });
    await drawer.getByRole('button', { name: 'Close this dialog' }).click();
    await page.getByRole('button', { name: '退款', exact: true }).click();
    const adminDialog = page.getByRole('dialog', { name: '发起退款', exact: true });
    await adminDialog.getByText('Test Customer · customer@example.com', { exact: true }).waitFor();
    assert.equal(await adminDialog.getByRole('textbox', { name: '退款原因', exact: true }).inputValue(), 'I purchased the wrong story');
    assert.deepEqual(errors, []);
    console.log(`Purchase refund and applicant visibility passed at ${width}px`);
    await page.close();
  }
} finally { await browser.close(); }
