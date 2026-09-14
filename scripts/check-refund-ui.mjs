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
    let refundMode = 'success';
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error') console.log(message.text()); });
    page.on('requestfailed', (request) => console.log('Request failed:', request.url(), request.failure()));
    const order = {
      orderNo: 'RN-20260914-1789386400525-25363c', seriesId: 's', seriesTitle: 'Refund Test Series', email: 'test@example.com', country: 'US',
      amount: 9.99, currency: 'USD', fee: 0.4, netAmount: 9.59, status: 'paid', paypalOrderId: 'PP-TEST', captureId: 'CAP-TEST',
      paymentMethod: 'apple_pay', createdAt: new Date().toISOString(), callbackAt: null, entitlement: 'granted', refund: { status: 'failed', amount: 9.99 }, note: null,
    };
    await page.route('**/api/**', async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (!path.startsWith('/api/')) return route.continue();
      let data;
      if (path.endsWith('/auth/session')) data = { id: 'test-admin', name: 'Test Admin', email: 'admin@example.com', role: 'super_admin' };
      else if (path.endsWith('/pending-items')) data = { items: [] };
      else if (path.endsWith('/refund')) {
        const input = route.request().postDataJSON();
        submissions.push(input);
        if (refundMode === 'uncertain') return route.fulfill({ status: 409, json: { data: { code: 'REFUND_RECONCILIATION_REQUIRED', message: '上一笔退款结果尚未确认，请先核验退款。', originalAmount: '9.99' } } });
        if (input.method === 'cancel') {
          order.refund.status = 'cancelled';
          data = { orderNo: order.orderNo, status: 'cancelled', synchronized: false };
        } else data = { orderNo: order.orderNo, status: 'refunded', synchronized: true };
      } else if (path.endsWith('/verify')) {
        data = { paypalStatus: 'COMPLETED', captureStatus: 'COMPLETED', refundStatus: null, synchronized: false, refundReconciliationRequired: true, refundAmount: '9.99', message: '收款已核验，但上一笔退款结果仍未确认。请按原申请金额重试，或在 PayPal 商户后台核对退款记录。' };
      } else if (path.endsWith('/orders')) data = { connected: true, generatedAt: new Date().toISOString(), items: [order], total: 1, summary: { todayOrders: 1, paidAmount: 9.99, pending: 0, exceptions: 0 } };
      else return route.fulfill({ status: 404, json: { message: 'Unexpected mock request' } });
      await route.fulfill({ json: { data } });
    });
    // Serve the public SPA shell; all API traffic remains mocked, including authentication.
    await page.route(`${baseURL}/admin/orders`, async (route) => {
      const response = await route.fetch({ url: `${baseURL}/admin/login` });
      await route.fulfill({ response });
    });
    await page.goto(`${baseURL}/admin/orders`);
    await page.getByRole('button', { name: '退款', exact: true }).click({ timeout: 10000 }).catch(async (error) => {
      console.log({ url: page.url(), errors, body: await page.locator('body').innerText() });
      throw error;
    });
    const dialog = page.getByRole('dialog', { name: '发起退款', exact: true });
    const amount = dialog.getByRole('textbox', { name: '退款金额', exact: true });
    assert.equal(await amount.isEnabled(), true);
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
    await page.getByRole('button', { name: '退款', exact: true }).click();
    await amount.fill('0.66');
    await dialog.getByRole('textbox', { name: '退款原因', exact: true }).fill('Customer requested another refund');
    refundMode = 'uncertain';
    await dialog.getByRole('button', { name: '确认退款', exact: true }).click();
    await dialog.getByText('上一笔退款结果尚未确认，请先核验退款。', { exact: true }).waitFor();
    await dialog.getByRole('button', { name: '恢复原金额 9.99' }).click();
    assert.equal(await amount.inputValue(), '9.99');
    await dialog.getByRole('button', { name: '核验退款', exact: true }).click();
    await dialog.getByText(/收款已核验，但上一笔退款结果仍未确认/).waitFor();
    await dialog.getByRole('button', { name: '取消失败退款', exact: true }).click();
    await dialog.getByText('上一笔退款结果尚未确认，请先核验退款。', { exact: true }).waitFor();
    assert.equal(order.refund.status, 'failed');
    await page.screenshot({ path: `artifacts/screenshots/refund-recovery-${width}.png` });
    const recoveryBounds = await dialog.boundingBox();
    assert.ok(recoveryBounds.x >= 0 && recoveryBounds.x + recoveryBounds.width <= width && recoveryBounds.y >= 0 && recoveryBounds.y + recoveryBounds.height <= 900);
    refundMode = 'success';
    await dialog.getByRole('button', { name: '取消失败退款', exact: true }).click();
    await dialog.getByText(/上一笔申请：已取消/).waitFor();
    assert.equal(await dialog.getByRole('textbox', { name: '退款原因', exact: true }).inputValue(), '');
    await amount.fill('0.66');
    await dialog.getByRole('textbox', { name: '退款原因', exact: true }).fill('New partial refund after closing failure');
    await dialog.getByRole('button', { name: '确认退款', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(submissions.at(-1).amount, '0.66');
    assert.equal(submissions.at(-1).method, 'paypal_api');
    assert.deepEqual(errors, []);
    console.log(`Refund UI passed at ${width}px: validation, submission, manual recording, reconciliation, cancellation and reapplication`);
    await page.close();
  }
} finally {
  await browser.close();
}
