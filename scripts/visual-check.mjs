import { chromium } from 'playwright-core';
import { mkdir } from 'node:fs/promises';

const baseURL = process.env.VISUAL_BASE_URL || 'http://127.0.0.1:3001';
const outputDir = 'artifacts/screenshots';
const executablePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

await mkdir(outputDir, { recursive: true });

const browser = await chromium.launch({ executablePath, headless: true });

const bytesToBase64Url = (bytes) => Buffer.from(bytes).toString('base64url');
const base64UrlToBytes = (value) => Buffer.from(value, 'base64url');

const createAdminProof = async (password, { challenge, salt, iterations }) => {
  const passwordKey = await crypto.subtle.importKey('raw', Buffer.from(password), 'PBKDF2', false, ['deriveBits']);
  const passwordHash = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: base64UrlToBytes(salt), iterations }, passwordKey, 256);
  const proofKey = await crypto.subtle.importKey('raw', passwordHash, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return bytesToBase64Url(await crypto.subtle.sign('HMAC', proofKey, Buffer.from(challenge)));
};

const addAdminSession = async (page) => {
  const challengeResponse = await page.request.post(`${baseURL}/api/admin/auth/challenge`, {
    data: { email: 'admin@reelnova.com' },
  });
  if (!challengeResponse.ok()) throw new Error(`Admin challenge failed: ${challengeResponse.status()} ${await challengeResponse.text()}`);
  const challenge = (await challengeResponse.json()).data;
  const proof = await createAdminProof('ReelNova@2026', challenge);
  const response = await page.request.post(`${baseURL}/api/admin/auth/login`, {
    data: { email: 'admin@reelnova.com', challenge: challenge.challenge, proof, remember: true },
  });
  if (!response.ok()) throw new Error(`Admin login failed: ${response.status()} ${await response.text()}`);
};

const userEmail = process.env.VISUAL_USER_EMAIL || 'visual-check@reelnova.test';
const userPassword = process.env.VISUAL_USER_PASSWORD || 'VisualCheck2026';
const userCookies = [];

const addUserSession = async (page) => {
  if (!userCookies.length) {
    let response = await page.request.post(`${baseURL}/api/auth/login`, {
      data: { email: userEmail, password: userPassword, remember: true },
    });
    if (response.status() === 401) {
      response = await page.request.post(`${baseURL}/api/auth/register`, {
        data: { name: 'Visual Check', email: userEmail, password: userPassword, remember: true },
      });
    }
    if (!response.ok()) throw new Error(`User authentication failed: ${response.status()} ${await response.text()}`);
    userCookies.push(...await page.context().cookies(baseURL));
  }
  await page.context().addCookies(userCookies);
};

const inspectPage = async (name, path, viewport) => {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
  if (path.startsWith('/admin') && path !== '/admin/login') await addAdminSession(page);
  if (!path.startsWith('/admin') && path !== '/login' && path !== '/register') await addUserSession(page);
  const errors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${baseURL}${path}`, { waitUntil: 'networkidle' });
  await page.screenshot({ path: `${outputDir}/${name}.png`, fullPage: false });
  const layout = await page.evaluate(() => {
    const overflow = [...document.querySelectorAll('body *')]
      .filter((element) => {
        if (element.closest('.el-table__inner-wrapper')) return false;
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.right > 0 && rect.left < window.innerWidth && (rect.right > window.innerWidth + 1 || rect.left < -1);
      })
      .slice(0, 10)
      .map((element) => ({ tag: element.tagName, className: element.className, rect: element.getBoundingClientRect().toJSON() }));
    return {
      viewportWidth: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      bodyWidth: document.body.scrollWidth,
      overflow,
    };
  });
  await page.close();
  return { name, layout, errors };
};

const results = [];
results.push(await inspectPage('h5-login-1280', '/login', { width: 1280, height: 800 }));
results.push(await inspectPage('h5-login-390', '/login', { width: 390, height: 844 }));
results.push(await inspectPage('h5-register-390', '/register', { width: 390, height: 844 }));

const resetPage = await browser.newPage({ viewport: { width: 1470, height: 837 }, deviceScaleFactor: 2 });
await resetPage.route('**/api/auth/password-reset', route => route.fulfill({
  status: 503,
  contentType: 'application/json',
  body: JSON.stringify({ statusCode: 503, message: 'Account service unavailable' }),
}));
await resetPage.goto(`${baseURL}/login`, { waitUntil: 'networkidle' });
await resetPage.getByRole('button', { name: 'Forgot password?' }).click();
await resetPage.getByLabel('Email', { exact: true }).fill('jimmy47442@gmail.com');
await resetPage.getByLabel('New password', { exact: true }).fill('hu20040303');
await resetPage.getByLabel('Confirm new password', { exact: true }).fill('hu20040303');
await resetPage.getByRole('button', { name: 'Reset password' }).click();
const resetError = resetPage.getByRole('alert');
await resetError.waitFor();
await resetPage.screenshot({ path: `${outputDir}/h5-reset-1470@2x.png`, fullPage: false });
results.push({
  name: 'h5-reset-1470@2x',
  resetErrorVisible: await resetError.isVisible(),
  resetErrorText: await resetError.textContent(),
  backToSignInVisible: await resetPage.getByRole('button', { name: 'Back to sign in' }).isVisible(),
  documentWidth: await resetPage.evaluate(() => document.documentElement.scrollWidth),
});
await resetPage.close();

results.push(await inspectPage('h5-home-390', '/', { width: 390, height: 844 }));
results.push(await inspectPage('h5-detail-390', '/series/vows-and-vengeance', { width: 390, height: 844 }));
results.push(await inspectPage('h5-watch-lock-390', '/watch/vows-and-vengeance/4', { width: 390, height: 844 }));
results.push(await inspectPage('admin-dashboard-1440', '/admin', { width: 1440, height: 1000 }));
results.push(await inspectPage('admin-series-1440', '/admin/series', { width: 1440, height: 1000 }));
results.push(await inspectPage('admin-orders-1440', '/admin/orders', { width: 1440, height: 1000 }));
results.push(await inspectPage('admin-operations-1440', '/admin/operations', { width: 1440, height: 1000 }));
results.push(await inspectPage('admin-taxonomy-1440', '/admin/taxonomy', { width: 1440, height: 1000 }));
results.push(await inspectPage('admin-users-1440', '/admin/users', { width: 1440, height: 1000 }));
results.push(await inspectPage('admin-reconciliation-1440', '/admin/reconciliation', { width: 1440, height: 1000 }));
results.push(await inspectPage('admin-system-1440', '/admin/system', { width: 1440, height: 1000 }));
results.push(await inspectPage('admin-domains-1440', '/admin/domains', { width: 1440, height: 1000 }));
results.push(await inspectPage('admin-audit-1440', '/admin/audit', { width: 1440, height: 1000 }));
results.push(await inspectPage('admin-administrators-1440', '/admin/administrators', { width: 1440, height: 1000 }));
results.push(await inspectPage('admin-orders-390', '/admin/orders', { width: 390, height: 844 }));

const interactionPage = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
await addAdminSession(interactionPage);
const interactionErrors = [];
interactionPage.on('console', (message) => { if (message.type() === 'error') interactionErrors.push(message.text()); });
interactionPage.on('pageerror', (error) => interactionErrors.push(error.message));
await interactionPage.goto(`${baseURL}/admin/series`, { waitUntil: 'networkidle' });
await interactionPage.getByRole('button', { name: '新建短剧' }).click();
const createDialogVisible = await interactionPage.getByRole('dialog', { name: '新建短剧' }).isVisible();
await interactionPage.keyboard.press('Escape');
await interactionPage.goto(`${baseURL}/admin/orders`, { waitUntil: 'networkidle' });
const orderDetailButton = interactionPage.getByRole('button', { name: '详情' }).first();
const hasOrderDetail = await orderDetailButton.count() > 0;
if (hasOrderDetail) await orderDetailButton.click();
const orderDrawerVisible = hasOrderDetail ? await interactionPage.getByRole('dialog', { name: '订单详情' }).isVisible() : null;
if (hasOrderDetail) await interactionPage.keyboard.press('Escape');
await interactionPage.keyboard.press('Meta+k');
const commandDialogVisible = await interactionPage.getByRole('dialog', { name: '快速导航' }).isVisible();
results.push({ name: 'admin-interactions', createDialogVisible, orderDrawerVisible, commandDialogVisible, errors: interactionErrors });
await interactionPage.close();

const authPage = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
await authPage.goto(`${baseURL}/admin/system`, { waitUntil: 'networkidle' });
const protectedRouteRedirected = authPage.url().includes('/admin/login?redirect=/admin/system');
const protectedShellHidden = await authPage.locator('.admin-app').count() === 0;
await authPage.locator('input[type="email"]').fill('admin@reelnova.com');
await authPage.locator('input[type="password"]').fill('ReelNova@2026');
await authPage.getByRole('button', { name: '登录工作台' }).click();
await authPage.waitForURL(`${baseURL}/admin/system`);
const loginRestoredRoute = authPage.url().endsWith('/admin/system');
await authPage.locator('.admin-user').click();
await authPage.getByText('退出登录', { exact: true }).click();
await authPage.waitForURL(/\/admin\/login/);
const logoutReturnedToLogin = authPage.url().includes('/admin/login');
results.push({ name: 'admin-auth', protectedRouteRedirected, protectedShellHidden, loginRestoredRoute, logoutReturnedToLogin });
await authPage.close();

const checkoutPage = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
await addUserSession(checkoutPage);
await checkoutPage.goto(`${baseURL}/series/vows-and-vengeance`, { waitUntil: 'networkidle' });
await checkoutPage.locator('.detail-actions .button--ghost').click();
await checkoutPage.locator('.unlock-sheet').waitFor();
await checkoutPage.waitForTimeout(350);
await checkoutPage.screenshot({ path: `${outputDir}/h5-unlock-390.png`, fullPage: false });
results.push({ name: 'h5-unlock-390', visible: await checkoutPage.locator('.unlock-sheet').isVisible() });
await checkoutPage.close();

const unauthenticatedPage = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
await unauthenticatedPage.goto(`${baseURL}/profile`, { waitUntil: 'networkidle' });
const consumerProtectedRouteRedirected = unauthenticatedPage.url().includes('/login?redirect=/profile');
const guestEntryRemoved = await unauthenticatedPage.getByRole('button', { name: 'Continue as guest' }).count() === 0;
results.push({ name: 'consumer-auth', protectedRouteRedirected: consumerProtectedRouteRedirected, guestEntryRemoved });
await unauthenticatedPage.close();

await browser.close();
console.log(JSON.stringify(results, null, 2));
