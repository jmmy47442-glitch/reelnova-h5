import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright-core';

// Contract/browser tests use mocked payment providers; they do not charge money.
const baseURL = process.env.CHECKOUT_TEST_BASE_URL || 'http://localhost:3100';
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const series = { id: 'checkout-test', slug: 'checkout-test', title: 'Checkout Test', tagline: 'Payment test', description: 'Payment test', coverUrl: '/favicon.svg', backdropUrl: '/favicon.svg', price: 9.99, originalPrice: 19.99, episodeCount: 2, freeEpisodeCount: 1, genres: [], cast: [], tags: [], badge: 'NEW', episodes: [], purchased: false, rating: 4.8, views: 100, durationMinutes: 2 };
const results = [];
await mkdir('artifacts/screenshots', { recursive: true });
const envelope = (data) => ({ code: 0, message: 'OK', requestId: 'test', data });
async function scenario(name, options, run, beforeOpen) {
  const context = await browser.newContext({ viewport: { width: 375, height: 812 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  const calls = []; let captures = 0; let createdOrder; let configRequests = 0; let sdkRequests = 0;
  const stalledSdkRoutes = [];
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript((options) => {
    window.__testOptions = options;
    window.__appleResults = [];
    window.__submitCount = 0;
    if (options.apple !== false) {
      window.ApplePaySession = class {
        static supportsVersion() { return true; }
        static canMakePayments() { return true; }
        static STATUS_SUCCESS = 1;
        static STATUS_FAILURE = 0;
        constructor(version, request) { window.__appleRequest = request; window.__appleSession = this; }
        begin() { queueMicrotask(() => this.onvalidatemerchant({ validationURL: 'https://apple-pay-gateway.apple.com/test' })); }
        completeMerchantValidation() { queueMicrotask(() => this.onpaymentauthorized({ payment: { token: { test: true }, billingContact: { countryCode: 'US' } } })); }
        completePayment(status) { window.__appleResults.push(status); }
        abort() {}
      };
    }
  }, options);
  await page.route('https://www.paypal.com/sdk/js?**', async (route) => {
    sdkRequests++;
    if (options.sdkFailure) return route.abort();
    if (options.sdkStalled && await page.evaluate(() => window.__testOptions.sdkStalled)) { stalledSdkRoutes.push(route); return; }
    return route.fulfill({ contentType: 'application/javascript', body: `
      window.paypal = {
        FUNDING: { PAYPAL: 'paypal' },
        Buttons: (callbacks) => ({
          render: async (host) => { const button = document.createElement('button'); button.textContent = 'Mock PayPal checkout'; button.onclick = async () => { try { const orderID = await callbacks.createOrder(); if (window.__testOptions.cancel) await callbacks.onCancel(); else await callbacks.onApprove({ orderID }); } catch (error) { callbacks.onError(error); } }; host.appendChild(button); if (window.__testOptions.slowPayPalRender) await new Promise(resolve => { window.__finishPayPalRender = resolve; }); }, close: () => {},
        }),
        CardFields: (callbacks) => {
          const getState = () => window.__testOptions.missingCardDetails ? {
            isFormValid: false, fields: {
              cardNameField: { isValid: true }, cardNumberField: { isValid: true },
              cardExpiryField: { isValid: false, isEmpty: true }, cardCvvField: { isValid: false, isEmpty: true },
            },
          } : { isFormValid: window.__testOptions.invalidCard !== true };
          window.__correctCardDetails = () => { window.__testOptions.missingCardDetails = false; callbacks.inputEvents?.onChange?.(getState()); };
          const field = () => ({ render: async (host) => { if (window.__testOptions.slowCardRender) await new Promise(() => {}); const input = document.createElement('input'); input.setAttribute('aria-label', 'Hosted field'); host.appendChild(input); }, close: () => {} });
          return { isEligible: () => window.__testOptions.cardEligible !== false,
            NameField: field, NumberField: field, ExpiryField: field, CVVField: field,
            getState: async () => getState(),
            submit: async () => { window.__submitCount++; const orderID = await callbacks.createOrder(); await callbacks.onApprove({ orderID }); },
          };
        },
        Applepay: () => ({ config: async () => { window.__appleConfigCalls = (window.__appleConfigCalls || 0) + 1; if (window.__testOptions.slowAppleConfig) await new Promise(() => {}); if (window.__testOptions.appleConfigFailure) throw new Error('Domain unregistered'); return { isEligible: true, countryCode: 'US', merchantCapabilities: ['supports3DS'], supportedNetworks: ['visa'] }; },
          validateMerchant: async () => { if (window.__testOptions.merchantFailure) throw Object.assign(new Error('APPLE_PAY_MERCHANT_SESSION_VALIDATION_ERROR'), { paypalDebugId: 'test-domain-debug' }); return { merchantSession: {} }; },
          confirmOrder: async (input) => { window.__appleConfirm = input; return { status: 'APPROVED' }; },
        }),
      };` });
  });
  await page.route(/^https?:\/\/[^/]+\/api\//, async (route) => {
    const request = route.request(); const url = new URL(request.url());
    const path = url.pathname; const body = request.postDataJSON();
    if (request.method() === 'POST') calls.push({ path, body });
    let data = {};
    if (path === '/api/paypal/config') {
      configRequests++;
      if (options.configStalled) return;
      data = { environment: 'sandbox', clientId: 'mock-client', available: options.configUnavailable !== true };
    }
    else if (path === '/api/auth/session') data = { userId: 'test-user', email: 'test@example.com', name: 'Test' };
    else if (path.startsWith('/api/series/')) data = series;
    else if (path === '/api/orders') {
      createdOrder = { orderNo: 'RN-TEST', seriesId: series.id, seriesTitle: series.title, amount: options.priceChanged ? 10.99 : 9.99, currency: 'USD', status: 'processing', paypalOrderId: 'PP-TEST', paymentMethod: body.paymentMethod, approvalUrl: 'https://www.sandbox.paypal.com/checkoutnow?token=PP-TEST' };
      data = createdOrder;
    } else if (path === '/api/paypal/capture') {
      captures++;
      if (options.captureTimeout || options.declined) return route.fulfill({ status: options.declined ? 422 : 504, json: { data: { code: options.declined ? 'PAYMENT_CAPTURE_DENIED' : 'PAYMENT_CONFIRMATION_TIMEOUT' } } });
      data = { orderNo: 'RN-TEST', status: 'paid' };
    } else if (path.startsWith('/api/orders/')) data = { ...createdOrder, status: options.captureTimeout ? 'paid' : 'processing', entitlementStatus: options.captureTimeout ? 'granted' : 'pending' };
    else if (path === '/api/paypal/cancel') data = { orderNo: 'RN-TEST', status: 'cancelled' };
    else if (path === '/api/me/settings') data = { locale: 'en', theme: 'dark' };
    return route.fulfill({ json: envelope(data) });
  });
  try {
    await page.goto(`${baseURL}/login`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof window.useNuxtApp === 'function' && typeof window.useNuxtApp().$router?.push === 'function', { timeout: 20_000 }).catch(async (error) => { console.log('Hydration errors', errors); console.log(await page.locator('body').innerText()); throw error; });
    await page.evaluate(async (series) => {
      const nuxt = window.useNuxtApp();
      nuxt.payload.state['$suser-session'] = { userId: 'test-user', email: 'test@example.com' };
      nuxt.payload.state['$suser-session-checked'] = true;
      await nuxt.$router.push(`/series/${series.slug}`);
    }, series);
    if (beforeOpen) await beforeOpen({ page, calls });
    await page.locator('.detail-actions .button--ghost').click({ timeout: 20_000 }).catch(async (error) => {
      console.log('Checkout navigation failed', page.url(), await page.locator('body').innerText());
      throw error;
    });
    await page.getByRole('dialog').waitFor();
    assert.equal(await page.locator('.payment-methods button:visible').count(), 3);
    assert.equal(await page.locator('.payment-method[aria-pressed="true"]').count(), 0);
    assert.equal(await page.locator('.checkout-loading:visible, .paypal-buttons:visible, .paypal-card-fields:visible, .apple-pay-button:visible, .payment-unavailable:visible').count(), 0);
    await run({ page, calls, captures: () => captures, configRequests: () => configRequests, sdkRequests: () => sdkRequests, releaseStalledSdk: () => Promise.all(stalledSdkRoutes.splice(0).map(route => route.abort())) });
    assert.deepEqual(errors, [], `Unexpected browser errors: ${errors.join('; ')}`);
    results.push({ name, passed: true });
    console.log(`PASS ${name}`);
  } finally { await context.close(); }
}
try {
  await scenario('payment buttons appear before configuration; loading starts only after selection', { configStalled: true }, async ({ page, calls }) => {
    await page.screenshot({ path: 'artifacts/screenshots/checkout-buttons-375.png', fullPage: true });
    await page.getByRole('button', { name: 'Apple Pay', exact: true }).click();
    await page.getByText('Preparing Apple Pay…', { exact: true }).waitFor({ timeout: 1000 });
    await page.getByRole('button', { name: 'Credit or debit card', exact: true }).click();
    await page.getByText('Preparing Credit or debit card…', { exact: true }).waitFor({ timeout: 1000 });
    assert.equal(calls.filter((call) => call.path === '/api/orders').length, 0);
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await page.locator('.detail-actions .button--ghost').click();
    await page.getByText('Choose how you would like to pay.', { exact: true }).waitFor();
    assert.equal(await page.locator('.checkout-loading:visible').count(), 0);
  });
  await scenario('site entry warms providers while only the selected UI mounts', {}, async ({ page, calls }) => {
    await page.waitForFunction(() => window.__appleConfigCalls === 1);
    assert.equal(await page.locator('.paypal-buttons:visible, .paypal-card-fields:visible, .apple-pay-button:visible').count(), 0);
    assert.equal(await page.evaluate(() => window.__appleConfigCalls), 1);
    assert.equal(await page.evaluate(() => window.__correctCardDetails), undefined);
    await page.getByRole('button', { name: 'PayPal', exact: true }).click();
    await page.getByRole('button', { name: 'Mock PayPal checkout' }).waitFor();
    assert.equal(await page.evaluate(() => window.__appleConfigCalls), 1);
    assert.equal(await page.evaluate(() => window.__correctCardDetails), undefined);
    assert.equal(calls.filter((call) => call.path === '/api/orders').length, 0);
  });
  await scenario('unavailable configuration keeps initial buttons and explains failure after selection', { configUnavailable: true }, async ({ page, calls }) => {
    await page.getByRole('button', { name: 'PayPal', exact: true }).click();
    await page.getByText('PayPal unavailable', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Retry PayPal' }).click();
    await page.getByText('PayPal unavailable', { exact: true }).waitFor();
    assert.equal(calls.filter((call) => call.path === '/api/orders').length, 0);
  });
  await scenario('page entry warms SDK and Apple Pay once without creating an order', {}, async ({ page, calls, configRequests, sdkRequests }) => {
    await page.getByRole('button', { name: 'Apple Pay', exact: true }).click();
    await page.getByRole('button', { name: 'Buy with Apple Pay' }).waitFor();
    assert.equal(configRequests(), 1);
    assert.equal(sdkRequests(), 1);
    assert.equal(await page.evaluate(() => window.__appleConfigCalls), 1);
    assert.equal(calls.filter((call) => call.path === '/api/orders').length, 0);
  }, async ({ page, calls }) => {
    await page.waitForFunction(() => window.__appleConfigCalls === 1);
    assert.equal(await page.getByRole('dialog').count(), 0);
    assert.equal(await page.evaluate(() => window.__appleConfigCalls), 1);
    assert.equal(await page.evaluate(() => window.__appleSession), undefined);
    assert.equal(calls.filter((call) => call.path === '/api/orders').length, 0);
  });
  await scenario('Apple Pay failure retries in place and still charges only on customer authorization', { appleConfigFailure: true }, async ({ page, calls, captures }) => {
    await page.getByRole('button', { name: 'Apple Pay', exact: true }).click();
    await page.getByRole('button', { name: 'Retry Apple Pay' }).waitFor();
    await page.evaluate(() => { window.__testOptions.appleConfigFailure = false; });
    await page.getByRole('button', { name: 'Retry Apple Pay' }).click();
    await page.getByRole('button', { name: 'Buy with Apple Pay' }).waitFor();
    assert.equal(calls.filter((call) => call.path === '/api/orders').length, 0);
    await page.getByRole('button', { name: 'Buy with Apple Pay' }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    assert.equal(captures(), 1);
  });
  await scenario('slow SDK keeps feedback without adding a second PayPal payment button', { sdkStalled: true }, async ({ page, calls }) => {
    await page.getByRole('button', { name: 'PayPal', exact: true }).click();
    await page.getByText('Preparing PayPal…', { exact: true }).waitFor();
    await page.getByText('Taking longer than usual.', { exact: false }).waitFor({ timeout: 5000 });
    assert.equal(await page.locator('.checkout-loading').isVisible(), true);
    assert.equal(await page.locator('.paypal-buttons').isVisible(), false);
    assert.equal(await page.getByRole('button', { name: 'Continue to PayPal', exact: true }).count(), 0);
    assert.equal(calls.filter((call) => call.path === '/api/orders').length, 0);
    await page.screenshot({ path: 'artifacts/screenshots/checkout-loading-375.png', fullPage: true });
  });
  await scenario('card fields submit and server capture unlock', {}, async ({ page, calls, captures }) => {
    await page.getByRole('button', { name: 'Credit or debit card', exact: true }).click();
    await page.getByRole('button', { name: 'Pay $9.99 USD', exact: true }).waitFor();
    assert.equal(await page.locator('.paypal-card-fields input').count(), 4);
    assert.equal(await page.locator('.payment-method svg, .payment-method img').count(), 3);
    const cardFieldBox = await page.locator('[data-card-number]').boundingBox();
    assert.ok(cardFieldBox && cardFieldBox.height >= 64 && cardFieldBox.height <= 70, `card field height was ${cardFieldBox?.height}`);
    await page.screenshot({ path: 'artifacts/screenshots/checkout-card-375.png', fullPage: true });
    await page.getByRole('button', { name: 'Pay $9.99 USD', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    assert.equal(calls.find((call) => call.path === '/api/orders').body.paymentMethod, 'card');
    assert.equal(captures(), 1);
  });
  await scenario('invalid card never creates or captures an order', { invalidCard: true }, async ({ page, calls }) => {
    await page.getByRole('button', { name: 'Credit or debit card', exact: true }).click();
    await page.getByRole('button', { name: 'Pay $9.99 USD', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'Check your card number' }).waitFor();
    assert.equal(calls.filter((call) => call.path === '/api/orders').length, 0);
  });
  await scenario('missing expiry and security code explain the problem and recover after correction', { missingCardDetails: true }, async ({ page, calls, captures }) => {
    await page.getByRole('button', { name: 'Credit or debit card', exact: true }).click();
    await page.getByRole('button', { name: 'Pay $9.99 USD', exact: true }).click();
    await page.getByText('Enter a valid expiration date (MM/YY).', { exact: true }).waitFor();
    await page.getByText('Enter the 3- or 4-digit security code on your card.', { exact: true }).waitFor();
    assert.equal(await page.locator('.paypal-card-fields label .card-field-error').count(), 2);
    assert.equal(calls.filter((call) => call.path === '/api/orders').length, 0);
    assert.equal(await page.evaluate(() => window.__submitCount), 0);
    await page.evaluate(() => window.__correctCardDetails());
    await page.locator('.paypal-card-fields [role="alert"]').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('.paypal-card-fields label .card-field-error').count(), 0);
    await page.getByRole('button', { name: 'Pay $9.99 USD', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    assert.equal(calls.filter((call) => call.path === '/api/orders').length, 1);
    assert.equal(captures(), 1);
  });
  await scenario('partially rendered PayPal stays hidden until only its official button is ready', { slowPayPalRender: true }, async ({ page, calls, captures }) => {
    await page.getByRole('button', { name: 'PayPal', exact: true }).click();
    await page.waitForFunction(() => typeof window.__finishPayPalRender === 'function');
    const sdkButton = page.locator('.paypal-buttons button');
    assert.equal(await sdkButton.count(), 1, 'SDK already inserted its button');
    assert.equal(await sdkButton.isVisible(), false, 'partial SDK content stays hidden');
    await page.getByText('Taking longer than usual.', { exact: false }).waitFor({ timeout: 5000 });
    assert.equal(await page.getByRole('button', { name: 'Continue to PayPal', exact: true }).count(), 0);
    assert.equal(await sdkButton.isVisible(), false);
    await page.evaluate(() => window.__finishPayPalRender());
    await sdkButton.waitFor();
    await page.locator('.checkout-loading').waitFor({ state: 'hidden' });
    assert.equal(await page.getByRole('button', { name: 'Retry PayPal', exact: true }).count(), 0);
    assert.equal(await sdkButton.count(), 1);
    await page.getByRole('button', { name: 'Credit or debit card', exact: true }).click();
    await page.getByRole('button', { name: 'Pay $9.99 USD', exact: true }).waitFor();
    await page.getByRole('button', { name: 'PayPal', exact: true }).click();
    assert.equal(await sdkButton.isVisible(), true);
    assert.equal(await page.locator('.checkout-loading').count(), 0);
    assert.equal(calls.filter((call) => call.path === '/api/orders').length, 0);
    await page.screenshot({ path: 'artifacts/screenshots/checkout-paypal-single-action-375.png', fullPage: true });
    await sdkButton.click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    assert.equal(calls.filter((call) => call.path === '/api/orders').length, 1);
    assert.equal(captures(), 1);
  });
  await scenario('slow PayPal rendering does not block card fields', { slowPayPalRender: true }, async ({ page }) => {
    await page.getByRole('button', { name: 'Credit or debit card', exact: true }).click();
    await page.getByRole('button', { name: 'Pay $9.99 USD', exact: true }).waitFor();
    assert.equal(await page.locator('.paypal-card-fields input').count(), 4);
    await page.locator('.checkout-loading').waitFor({ state: 'hidden', timeout: 2000 });
    await page.getByRole('button', { name: 'PayPal', exact: true }).click();
    await page.getByRole('button', { name: 'Retry PayPal', exact: true }).waitFor({ timeout: 12_000 });
    await page.locator('.checkout-loading').waitFor({ state: 'hidden' });
    await page.evaluate(() => window.__finishPayPalRender());
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.locator('.paypal-buttons').isVisible(), false);
    assert.equal(await page.getByRole('button', { name: 'Retry PayPal', exact: true }).isVisible(), true);
  });
  await scenario('stalled card and Apple Pay do not block a ready PayPal wallet', { slowCardRender: true, slowAppleConfig: true }, async ({ page }) => {
    await page.getByRole('button', { name: 'PayPal', exact: true }).click();
    await page.getByRole('button', { name: 'Mock PayPal checkout' }).waitFor();
    await page.locator('.checkout-loading').waitFor({ state: 'hidden', timeout: 2000 });
    assert.equal(await page.getByRole('button', { name: 'Continue to PayPal', exact: true }).count(), 0);
    await page.getByRole('button', { name: 'Credit or debit card', exact: true }).click();
    await page.getByText('Card fields could not be loaded.', { exact: false }).waitFor({ timeout: 12_000 });
    await page.locator('.checkout-loading').waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: 'Apple Pay', exact: true }).click();
    await page.getByText('Apple Pay cannot be tested on localhost', { exact: false }).waitFor();
    await page.locator('.checkout-loading').waitFor({ state: 'hidden' });
  });
  await scenario('stalled SDK retries to an official button without creating an order automatically', { sdkStalled: true }, async ({ page, calls, captures, releaseStalledSdk }) => {
    await page.getByRole('button', { name: 'PayPal', exact: true }).click();
    await page.getByText('Taking longer than usual.', { exact: false }).waitFor({ timeout: 5000 });
    await releaseStalledSdk();
    await page.getByRole('button', { name: 'Retry PayPal', exact: true }).waitFor({ timeout: 12_000 });
    await page.locator('.checkout-loading').waitFor({ state: 'hidden' });
    assert.equal(calls.filter((call) => call.path === '/api/orders').length, 0);
    assert.equal(await page.getByRole('button', { name: 'Continue to PayPal', exact: true }).count(), 0);
    // Let the next SDK request succeed; retry prepares controls, not an order.
    await page.evaluate(() => { window.__testOptions.sdkStalled = false; });
    await page.getByRole('button', { name: 'Retry PayPal', exact: true }).click();
    await page.getByRole('button', { name: 'Mock PayPal checkout' }).waitFor();
    assert.equal(calls.filter((call) => call.path === '/api/orders').length, 0);
    assert.equal(await page.locator('.paypal-buttons button').count(), 1);
    assert.equal(await page.getByRole('button', { name: 'Retry PayPal', exact: true }).count(), 0);
    await page.getByRole('button', { name: 'Mock PayPal checkout' }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    assert.equal(calls.filter((call) => call.path === '/api/orders').length, 1);
    assert.equal(captures(), 1);
  });
  await scenario('PayPal wallet still creates and captures', {}, async ({ page, calls, captures }) => {
    await page.getByRole('button', { name: 'PayPal', exact: true }).click();
    await page.getByRole('button', { name: 'Mock PayPal checkout' }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    assert.equal(calls.find((call) => call.path === '/api/orders').body.paymentMethod, 'paypal');
    assert.equal(captures(), 1);
  });
  await scenario('Apple Pay validates merchant, confirms token and captures', {}, async ({ page, calls, captures }) => {
    await page.getByRole('button', { name: 'Apple Pay', exact: true }).click();
    await page.locator('.apple-pay-button__logo').waitFor();
    await page.getByRole('button', { name: 'Buy with Apple Pay' }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    assert.equal(calls.find((call) => call.path === '/api/orders').body.paymentMethod, 'apple_pay');
    assert.equal(captures(), 1);
    assert.equal(await page.evaluate(() => window.__appleConfirm.orderId), 'PP-TEST');
    assert.deepEqual(await page.evaluate(() => window.__appleResults), [1]);
  });
  await scenario('Apple Pay merchant validation failure exposes a support reference without creating or charging an order', { merchantFailure: true }, async ({ page, calls, captures }) => {
    await page.getByRole('button', { name: 'Apple Pay', exact: true }).click();
    await page.getByRole('button', { name: 'Buy with Apple Pay' }).click();
    const alert = page.getByRole('alert');
    await alert.filter({ hasText: 'Apple Pay could not verify this store' }).waitFor();
    assert.ok((await alert.innerText()).includes('Reference: test-domain-debug.'));
    assert.equal(calls.filter((call) => call.path === '/api/orders').length, 0);
    assert.equal(captures(), 0);
    assert.equal(await page.evaluate(() => window.__appleConfirm), undefined);
    await page.getByRole('button', { name: 'Credit or debit card', exact: true }).click();
    assert.equal(await alert.count(), 0);
    await page.getByRole('button', { name: 'Pay $9.99 USD', exact: true }).waitFor();
  });
  await scenario('Apple Pay rejects changed price before confirming the wallet', { priceChanged: true }, async ({ page, captures }) => {
    await page.getByRole('button', { name: 'Apple Pay', exact: true }).click();
    await page.getByRole('button', { name: 'Buy with Apple Pay' }).click();
    await page.getByRole('alert').waitFor();
    assert.equal(captures(), 0);
    assert.deepEqual(await page.evaluate(() => window.__appleResults), [0]);
    assert.equal(await page.evaluate(() => window.__appleConfirm), undefined);
  });
  await scenario('localhost Apple Pay failure explains the verified-domain requirement', { appleConfigFailure: true }, async ({ page }) => {
    await page.getByRole('button', { name: 'Apple Pay', exact: true }).click();
    await page.getByText('Apple Pay cannot be tested on localhost', { exact: false }).waitFor();
  });
  await scenario('ambiguous capture polls the original order without a second charge', { captureTimeout: true }, async ({ page, calls, captures }) => {
    await page.getByRole('button', { name: 'Credit or debit card', exact: true }).click();
    await page.getByRole('button', { name: 'Pay $9.99 USD', exact: true }).click();
    await page.getByRole('heading', { name: 'Payment processing' }).waitFor();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    assert.equal(captures(), 1);
    assert.equal(calls.filter((call) => call.path === '/api/orders').length, 1);
  });
  await scenario('ineligible card and unsupported Apple Pay show useful alternatives', { cardEligible: false, apple: false }, async ({ page }) => {
    await page.getByRole('button', { name: 'Credit or debit card', exact: true }).click();
    await page.getByText('Direct card payment is unavailable', { exact: false }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Pay $9.99 USD', exact: true }).isVisible(), false);
    await page.getByRole('button', { name: 'Apple Pay', exact: true }).click();
    await page.getByText('Use a compatible Apple device', { exact: false }).waitFor();
    await page.setViewportSize({ width: 812, height: 375 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  });
  await scenario('cancel and repeated reopen keep a working checkout', { cancel: true }, async ({ page, calls }) => {
    await page.getByRole('button', { name: 'PayPal', exact: true }).click();
    await page.getByRole('button', { name: 'Mock PayPal checkout' }).click();
    await page.getByRole('alert').filter({ hasText: 'Checkout cancelled' }).waitFor();
    assert.equal(calls.filter((call) => call.path === '/api/paypal/cancel').length, 1);
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await page.locator('.detail-actions .button--ghost').click();
    await page.getByRole('button', { name: 'Credit or debit card', exact: true }).click();
    await page.getByRole('button', { name: 'Pay $9.99 USD', exact: true }).waitFor();
    assert.equal(await page.locator('.paypal-card-fields input').count(), 4);
  });
} finally { await browser.close(); }
console.log(`${results.length} checkout browser scenarios passed (mock providers; no live charge).`);
