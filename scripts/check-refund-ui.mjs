import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const baseURL = process.env.VISUAL_BASE_URL || 'http://127.0.0.1:3002';
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
await mkdir('artifacts/screenshots', { recursive: true });
try {
  for (const width of [1440, 375]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const submissions = [];
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const order = {
      orderNo: 'RN-20260914-1789386400525-25363c', seriesId: 's', seriesTitle: 'Refund Test Series', email: 'test@example.com', country: 'US',
      amount: 9.99, currency: 'USD', fee: 0.4, netAmount: 9.59, status: 'paid', paypalOrderId: 'PP-TEST', captureId: 'CAP-TEST',
      paymentMethod: 'apple_pay', createdAt: new Date().toISOString(), callbackAt: null, entitlement: 'granted', refund: { status: null, amount: null }, note: null,
    };
    await page.route('**/api/**', async (route) => {
      const path = new URL(route.request().url()).pathname;
      let data;
      if (path.endsWith('/auth/session')) data = { id: 'test-admin', name: 'Test Admin', email: 'admin@example.com', role: 'super_admin' };
      else if (path.endsWith('/pending-items')) data = { items: [] };
      else if (path.endsWith('/refund')) {
        submissions.push(route.request().postDataJSON());
        data = { orderNo: order.orderNo, status: 'refunded', synchronized: true };
      } else if (path.endsWith('/orders')) data = { connected: true, generatedAt: new Date().toISOString(), items: [order], total: 1, summary: { todayOrders: 1, paidAmount: 9.99, pending: 0, exceptions: 0 } };
      else return route.fulfill({ status: 404, json: { message: 'Unexpected mock request' } });
      await route.fulfill({ json: { data } });
    });
    await page.goto(`${baseURL}/admin/orders`);
    await page.getByRole('button', { name: '退款', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '发起退款', exact: true });
    const amount = dialog.getByRole('textbox', { name: '退款金额', exact: true });
    assert.equal(await amount.inputValue(), '9.99');
    await dialog.getByRole('textbox', { name: '退款原因', exact: true }).fill('Customer requested partial refund');
    for (const invalid of ['0', '-1', '10.00', '1.001', '']) {
      await amount.fill(invalid);
      await dialog.getByRole('button', { name: '确认退款', exact: true }).click();
      await dialog.getByText('退款金额须大于 0，最多两位小数，且不超过订单金额', { exact: true }).waitFor();
      assert.equal(submissions.length, 0);
    }
    await amount.fill('2.35');
    await dialog.getByRole('button', { name: '全额退款', exact: true }).click();
    assert.equal(await amount.inputValue(), '9.99');
    await amount.fill('2.35');
    await page.screenshot({ path: `artifacts/screenshots/refund-${width}.png` });
    const bounds = await dialog.boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width && bounds.y >= 0 && bounds.y + bounds.height <= 900);
    await dialog.getByRole('button', { name: '确认退款', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(submissions[0].amount, '2.35');
    assert.equal(submissions[0].method, 'paypal_api');
    await page.getByRole('button', { name: '退款', exact: true }).click();
    assert.equal(await amount.inputValue(), '9.99');
    assert.equal(await dialog.getByRole('textbox', { name: '退款原因', exact: true }).inputValue(), '');
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    await page.getByRole('button', { name: '人工记录', exact: true }).click();
    const manual = page.getByRole('dialog', { name: '记录人工退款', exact: true });
    await manual.getByRole('textbox', { name: '退款金额', exact: true }).fill('1.25');
    await manual.getByRole('textbox', { name: '退款原因', exact: true }).fill('Merchant portal refund completed');
    await manual.getByRole('button', { name: '记录已完成', exact: true }).click();
    await manual.waitFor({ state: 'hidden' });
    assert.equal(submissions[1].amount, '1.25');
    assert.equal(submissions[1].method, 'manual');
    assert.equal(submissions[1].providerStatus, 'COMPLETED');
    assert.deepEqual(errors, []);
    console.log(`Refund UI passed at ${width}px: validation, amount submission, reset and manual recording`);
    await page.close();
  }
} finally {
  await browser.close();
}
