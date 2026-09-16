import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const load = (path, imports = {}, globals = {}) => {
  const code = ts.transpileModule(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  runInNewContext(code, { exports, require: (name) => {
    if (!(name in imports)) throw new Error(`Unexpected import: ${name}`);
    return imports[name];
  }, ...globals });
  return exports;
};
const createError = (input) => Object.assign(new Error(input.statusMessage), input);
const reporting = load('server/utils/reporting-orders.ts', {}, { createError });
const today = new Date().toISOString().slice(0, 10);
const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
const older = new Date(Date.now() - 20 * 86400000).toISOString().slice(0, 10);
function harness() {
  const db = new DatabaseSync(':memory:');
  const directory = new URL('../migrations/', import.meta.url);
  for (const file of readdirSync(directory).filter((name) => name.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(file, directory), 'utf8'));
  db.exec("INSERT INTO users (user_id, email, created_at, updated_at, last_seen_at) VALUES ('u', 'u@example.test', 'now', 'now', 'now')");
  const insert = db.prepare(`INSERT INTO orders (order_no, series_id, series_slug, series_title, user_id,
    amount_cents, fee_cents, status, capture_id, created_at, updated_at, callback_at, paypal_environment, country, business_idempotency_key, price_version, pricing_snapshot_json, activity_snapshot_json)
    VALUES (?, 's', 's', 'Story', 'u', ?, ?, ?, ?, ?, ?, ?, ?, 'SG', ?, 'v1', '{}', '{}')`);
  const order = (id, { status = 'paid', amount = 1000, fee = 30, created = today, captured = today, environment = 'production' } = {}) => {
    insert.run(id, amount, fee, status, status === 'failed' ? null : `capture-${id}`, `${created}T00:00:00.000Z`, `${today}T00:00:00.000Z`, status === 'failed' ? null : `${captured}T00:00:00.000Z`, environment, `key-${id}`);
  };
  const refund = (id, orderNo, amount, status = 'completed') => db.prepare(`INSERT INTO refund_requests
    (id, order_no, capture_id, amount_cents, currency, status, reason, requested_by, created_at, updated_at, completed_at)
    VALUES (?, ?, ?, ?, 'USD', ?, 'test refund', 'admin', ?, ?, ?)`)
    .run(id, orderNo, `capture-${orderNo}`, amount, status, `${today}T00:00:00.000Z`, `${today}T00:00:00.000Z`, status === 'completed' ? `${today}T00:00:00.000Z` : null);
  const d1 = {
    d1All: async (_event, sql, params = []) => db.prepare(sql).all(...params),
    d1First: async (_event, sql, params = []) => db.prepare(sql).get(...params) || null,
    hasD1Connection: () => true,
  };
  const api = (name) => load(`server/api/admin/${name}.get.ts`, {
    '~/server/utils/cloudflare-d1': d1, '~/server/utils/reporting-orders': reporting,
    '~/server/utils/response': { ok: (data) => data },
  }, { defineEventHandler: (fn) => fn, getQuery: (event) => event.query || {}, getRouterParam: (event) => event.metric, createError }).default;
  return { db, order, refund, api, d1 };
}

test('reconciliation separates sandbox, preserves refunded captures, and deducts actual partial refunds by completion day', async () => {
  const h = harness();
  try {
    h.order('partial', { status: 'refunded', captured: yesterday, created: older });
    h.refund('partial-refund', 'partial', 300);
    h.order('full', { status: 'refunded', amount: 500, fee: 20 });
    h.refund('full-refund', 'full', 500);
    h.order('waiting', { status: 'refunding', amount: 200, fee: 10 });
    h.refund('pending-refund', 'waiting', 200, 'processing');
    h.order('sandbox', { amount: 90000, environment: 'sandbox' });
    h.order('RN-ACCEPT-PAID-2026', { amount: 90000 });
    h.order('failed', { status: 'failed' });
    const report = await h.api('reconciliation')({ query: { days: 7 } });
    const before = report.rows.find((row) => row.date === yesterday);
    const current = report.rows.find((row) => row.date === today);
    assert.equal(before.gross, 10); assert.equal(before.net, 9.7);
    assert.equal(current.gross, 7); assert.equal(current.refunds, 8);
    assert.equal(current.net, -1.3); assert.equal(current.paid, 2); assert.equal(current.exceptions, 1);
    const sandbox = await h.api('reconciliation')({ query: { environment: 'sandbox' } });
    assert.equal(sandbox.rows[0].gross, 900);
    await assert.rejects(h.api('reconciliation')({ query: { environment: "production' OR 1=1" } }), /Invalid reporting environment/);
  } finally { h.db.close(); }
});

test('dashboard, detail and orders agree when an older order captures today and is refunded', async () => {
  const h = harness();
  try {
    h.order('real', { created: older, status: 'refunded' }); h.refund('refund', 'real', 300);
    h.order('sandbox', { environment: 'sandbox', amount: 99900 });
    const dashboard = await h.api('dashboard')({});
    assert.equal(dashboard.metrics.orders.value, 0);
    assert.equal(dashboard.metrics.revenue.value, 10);
    assert.equal(dashboard.trends.find((row) => row.date === today).revenue, 10);
    assert.equal(dashboard.topSeries[0].revenue, 10);
    const detail = await h.api('metrics/[metric]')({ metric: 'revenue' });
    assert.equal(detail.value, 10); assert.equal(detail.recordCount, 1);
    const orders = await h.api('orders')({});
    assert.equal(orders.total, 1); assert.equal(orders.summary.paidAmount, 10);
    assert.equal(orders.items[0].netAmount, 6.7); assert.equal(orders.items[0].environment, 'production');
    assert.equal(orders.countries[0], 'SG');
    const sandbox = await h.api('orders')({ query: { environment: 'sandbox' } });
    assert.equal(sandbox.total, 1); assert.equal(sandbox.items[0].orderNo, 'sandbox');
    const ranking = load('server/utils/content-ranking.ts', { './cloudflare-d1': h.d1, './reporting-orders': reporting });
    assert.equal((await ranking.getSeriesBusinessMetrics({})).get('s').revenueCents, 700);
  } finally { h.db.close(); }
});
