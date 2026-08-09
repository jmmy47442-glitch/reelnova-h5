import { chromium } from 'playwright-core';
import { mkdir } from 'node:fs/promises';

const baseURL = process.env.VISUAL_BASE_URL || 'http://127.0.0.1:3001';
const outputDir = 'artifacts/screenshots';
const executablePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

await mkdir(outputDir, { recursive: true });

const browser = await chromium.launch({ executablePath, headless: true });

const inspectPage = async (name, path, viewport) => {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
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
results.push(await inspectPage('admin-orders-390', '/admin/orders', { width: 390, height: 844 }));

const interactionPage = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
const interactionErrors = [];
interactionPage.on('console', (message) => { if (message.type() === 'error') interactionErrors.push(message.text()); });
interactionPage.on('pageerror', (error) => interactionErrors.push(error.message));
await interactionPage.goto(`${baseURL}/admin/series`, { waitUntil: 'networkidle' });
await interactionPage.getByRole('button', { name: '新建短剧' }).click();
const createDialogVisible = await interactionPage.getByRole('dialog', { name: '新建短剧' }).isVisible();
await interactionPage.keyboard.press('Escape');
await interactionPage.goto(`${baseURL}/admin/orders`, { waitUntil: 'networkidle' });
await interactionPage.getByRole('button', { name: '详情' }).first().click();
const orderDrawerVisible = await interactionPage.getByRole('dialog', { name: '订单详情' }).isVisible();
await interactionPage.keyboard.press('Escape');
await interactionPage.keyboard.press('Meta+k');
const commandDialogVisible = await interactionPage.getByRole('dialog', { name: '快速导航' }).isVisible();
results.push({ name: 'admin-interactions', createDialogVisible, orderDrawerVisible, commandDialogVisible, errors: interactionErrors });
await interactionPage.close();

const checkoutPage = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
await checkoutPage.goto(`${baseURL}/series/vows-and-vengeance`, { waitUntil: 'networkidle' });
await checkoutPage.locator('.detail-actions .button--ghost').click();
await checkoutPage.locator('.unlock-sheet').waitFor();
await checkoutPage.waitForTimeout(350);
await checkoutPage.screenshot({ path: `${outputDir}/h5-unlock-390.png`, fullPage: false });
results.push({ name: 'h5-unlock-390', visible: await checkoutPage.locator('.unlock-sheet').isVisible() });
await checkoutPage.close();

await browser.close();
console.log(JSON.stringify(results, null, 2));
