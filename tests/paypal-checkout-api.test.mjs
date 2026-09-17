import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { runInNewContext } from 'node:vm';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import ts from 'typescript';
import * as checkout from '../server/utils/paypal-checkout.ts';
import * as paymentState from '../server/utils/paypal-payment-state.ts';
import * as refundAmount from '../shared/refund-amount.ts';

const createError = ({ statusMessage, ...data }) => Object.assign(new Error(statusMessage), data);
function harness({ afterCreate, beforeRead, afterCapture, beforeRefund, afterRefund } = {}) {
  const database = new DatabaseSync(':memory:');
  const directory = new URL('../migrations/', import.meta.url);
  for (const file of readdirSync(directory).filter((name) => name.endsWith('.sql')).sort()) database.exec(readFileSync(new URL(file, directory), 'utf8'));
  database.exec("INSERT INTO users (user_id, email, created_at, updated_at, last_seen_at) VALUES ('u', 'u@example.com', 'now', 'now', 'now')");
  const providerOrders = new Map(); let providerCreates = 0; let providerCaptures = 0;
  const providerRefunds = new Map();
  const d1 = {
    d1First: async (_event, sql, params = []) => database.prepare(sql).get(...params) || null,
    d1All: async (_event, sql, params = []) => database.prepare(sql).all(...params),
    d1Run: async (_event, sql, params = []) => database.prepare(sql).run(...params),
    d1Batch: async (_event, statements) => {
      database.exec('BEGIN');
      try {
        const results = statements.map(({ sql, params = [] }) => database.prepare(sql).run(...params));
        database.exec('COMMIT');
        return results;
      } catch (error) { database.exec('ROLLBACK'); throw error; }
    },
    getRequestCountry: () => 'US',
  };
  const providerFetch = async (url, options) => {
    if (url.endsWith('/token')) return { access_token: 'test-access-token' };
    if (url.includes('/v2/payments/captures/') && url.endsWith('/refund')) {
      await beforeRefund?.(options);
      const key = options.headers['PayPal-Request-Id'];
      if (!providerRefunds.has(key)) providerRefunds.set(key, { id: `REF-${key}`, status: 'COMPLETED', amount: options.body.amount });
      const refund = providerRefunds.get(key);
      assert.deepEqual(refund.amount, options.body.amount);
      await afterRefund?.(refund);
      return refund;
    }
    if (url.includes('/v2/payments/refunds/')) {
      return [...providerRefunds.values()].find((refund) => url.endsWith(encodeURIComponent(refund.id)));
    }
    if (url.endsWith('/v2/checkout/orders')) {
      providerCreates++;
      const key = options.headers['PayPal-Request-Id'];
      const id = `PP-${key}`;
      if (!providerOrders.has(id)) providerOrders.set(id, {
        id, status: 'CREATED', purchase_units: options.body.purchase_units,
        links: options.body.payment_source?.paypal ? [{ rel: 'payer-action', href: 'https://www.sandbox.paypal.com/checkout' }] : [],
      });
      await afterCreate?.(providerOrders.get(id), options.body);
      return providerOrders.get(id);
    }
    const id = decodeURIComponent(url.split('/orders/')[1]?.split('/')[0] || '');
    const order = providerOrders.get(id);
    if (!order) throw createError({ statusCode: 404, statusMessage: 'Missing' });
    if (url.endsWith('/capture')) {
      providerCaptures++;
      if (order.status !== 'APPROVED' && order.status !== 'COMPLETED') throw createError({ statusCode: 422, statusMessage: 'Not approved' });
      order.status = 'COMPLETED';
      order.purchase_units[0].payments = { captures: [{ id: `CAP-${id}`, status: 'COMPLETED', amount: order.purchase_units[0].amount }] };
      await afterCapture?.(order);
    } else {
      await beforeRead?.(order);
    }
    return order;
  };
  const imports = {
    '~/server/utils/cloudflare-d1': d1,
    '~/server/utils/user-profile': { upsertUserProfile: async () => {}, assertUserEnabled: async () => {} },
    '~/server/utils/system-config': { getSystemConfig: async (_e, _k, fallback) => fallback, saveSystemConfig: async () => {} },
    '~/server/utils/paypal-payment-state': paymentState,
    '~/shared/refund-amount': refundAmount,
    '~/server/utils/admin-rbac': { requireAdminPermission: () => ({ email: 'admin@example.com' }) },
    '~/server/utils/admin-audit': { recordAdminAudit: async () => {} },
    './paypal-checkout': checkout,
    ofetch: { ofetch: providerFetch },
    '~/server/utils/response': { ok: (data) => ({ data }) },
    '~/server/utils/user-auth': { getUserSession: async (event) => event.user === false ? null : { userId: event.user || 'u', email: 'u@example.com' } },
    '~/server/utils/managed-content': { getPublicSeries: async () => [{ id: 's', slug: 'series', title: 'Series', price: 9.99, originalPrice: 19.99 }] },
  };
  const load = (name) => {
    const source = readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
    const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
    const exports = {};
    runInNewContext(code, {
      exports, require: (name) => { if (!imports[name]) throw new Error(`Unexpected import ${name}`); return imports[name]; },
      createError, defineEventHandler: (fn) => fn, readBody: async (event) => event.body,
      getRouterParam: (event, name) => event.params?.[name],
      getQuery: (event) => event.query || {}, sendRedirect: (_event, location, statusCode) => ({ location, statusCode }),
      getRequestURL: () => new URL('https://example.com'), crypto: { randomUUID },
      useRuntimeConfig: () => ({ paypalEnvironment: 'sandbox', paypalClientId: 'test', paypalSecret: 'test', public: { paypalClientId: 'test' } }),
      btoa: (value) => Buffer.from(value).toString('base64'), $fetch: providerFetch,
    }, { filename: name });
    return exports;
  };
  imports['~/server/utils/reporting-orders'] = load('server/utils/reporting-orders.ts');
  imports['~/server/utils/paypal'] = load('server/utils/paypal.ts');
  return {
    db: database, providerOrders, creates: () => providerCreates, captures: () => providerCaptures,
    providerRefunds, refund: load('server/api/admin/orders/[orderNo]/refund.post.ts').default,
    customerRefund: load('server/api/me/orders/[orderNo]/refund.post.ts').default,
    adminOrders: load('server/api/admin/orders.get.ts').default,
    verify: load('server/api/admin/orders/[orderNo]/verify.post.ts').default,
    create: load('server/api/orders/index.post.ts').default,
    capture: load('server/api/paypal/capture.post.ts').default,
    cancel: load('server/api/paypal/cancel.post.ts').default,
    cancelRedirect: load('server/api/paypal/cancel.get.ts').default,
    paypal: imports['~/server/utils/paypal'],
  };
}
async function paidOrder(h) {
  const order = (await h.create({ body: { seriesId: 's', paymentMethod: 'card' } })).data;
  h.providerOrders.get(order.paypalOrderId).status = 'APPROVED';
  await h.capture({ body: { paypalOrderId: order.paypalOrderId } });
  return order;
}

test('customer refund is idempotent, visible to admin, and preserves access until approval', async () => {
  const h = harness();
  try {
    const order = await paidOrder(h);
    const event = { params: { orderNo: order.orderNo }, body: { reason: 'I purchased the wrong story', amount: '0.01', userId: 'someone-else' } };
    const results = await Promise.all([h.customerRefund(event), h.customerRefund(event)]);
    assert.ok(results.every((result) => result.data.refundStatus === 'pending'));
    assert.equal(h.db.prepare('SELECT COUNT(*) AS count FROM refund_requests').get().count, 1);
    assert.equal(h.db.prepare('SELECT COUNT(*) AS count FROM refund_events').get().count, 1);
    assert.equal(h.db.prepare('SELECT amount_cents FROM refund_requests').get().amount_cents, 999);
    assert.equal(h.db.prepare('SELECT status FROM entitlements').get().status, 'granted');
    assert.equal(h.db.prepare('SELECT status FROM orders').get().status, 'paid');
    assert.equal(h.providerRefunds.size, 0);
    const listed = (await h.adminOrders({ query: { environment: 'sandbox', refundStatus: 'pending' } })).data;
    assert.equal(listed.total, 1);
    assert.equal(listed.items[0].refund.customerRequest.userId, 'u');
    assert.equal(listed.items[0].refund.customerRequest.email, 'u@example.com');
    assert.equal(listed.items[0].refund.customerRequest.reason, event.body.reason);
    await h.refund({ params: event.params, body: { reason: 'Customer refund approved' } });
    assert.equal(h.providerRefunds.size, 1);
    assert.equal(h.db.prepare('SELECT status FROM entitlements').get().status, 'revoked');
    assert.equal((await h.customerRefund(event)).data.refundStatus, 'completed');
    assert.equal((await h.adminOrders({ query: { environment: 'sandbox' } })).data.items[0].refund.customerRequest.reason, event.body.reason);
  } finally { h.db.close(); }
});

test('customer refund rejects unauthenticated users, other owners, invalid reasons and unpaid orders', async () => {
  const h = harness();
  try {
    const order = await paidOrder(h);
    const event = { params: { orderNo: order.orderNo }, body: { reason: 'I purchased the wrong story' } };
    await assert.rejects(h.customerRefund({ ...event, user: false }), (error) => error.statusCode === 401);
    await assert.rejects(h.customerRefund({ ...event, user: 'another-user' }), (error) => error.statusCode === 404);
    for (const reason of ['', 'short', ' '.repeat(10), 'x'.repeat(501), {}, null]) {
      await assert.rejects(h.customerRefund({ ...event, body: { reason } }), (error) => error.statusCode === 400);
    }
    h.db.exec("UPDATE orders SET status = 'pending'");
    await assert.rejects(h.customerRefund(event), (error) => error.statusCode === 409);
    assert.equal(h.db.prepare('SELECT COUNT(*) AS count FROM refund_requests').get().count, 0);
    assert.equal(h.providerRefunds.size, 0);
  } finally { h.db.close(); }
});

test('rejected customer requests retain original applicant and reason without duplicate requests', async () => {
  const h = harness();
  try {
    const order = await paidOrder(h);
    const event = { params: { orderNo: order.orderNo }, body: { reason: 'I purchased the wrong story' } };
    await h.customerRefund(event);
    await h.refund({ params: event.params, body: { reason: 'Request reviewed and declined', method: 'reject' } });
    assert.equal((await h.customerRefund(event)).data.refundStatus, 'rejected');
    const listed = (await h.adminOrders({ query: { environment: 'sandbox' } })).data.items[0];
    assert.equal(listed.refund.customerRequest.userId, 'u');
    assert.equal(listed.refund.customerRequest.reason, event.body.reason);
    assert.equal(h.db.prepare('SELECT status FROM entitlements').get().status, 'granted');
  } finally { h.db.close(); }
});

for (const amount of ['0.01', '2.35', '9.99', undefined]) test(`admin refund amount ${amount ?? 'default full'} reaches PayPal and persists through replay`, async () => {
  const h = harness();
  try {
    const order = await paidOrder(h);
    const event = { params: { orderNo: order.orderNo }, body: { reason: 'Customer requested refund', ...(amount === undefined ? {} : { amount }) } };
    assert.equal((await h.refund(event)).data.status, 'refunded');
    assert.equal([...h.providerRefunds.values()][0].amount.value, amount ?? '9.99');
    assert.equal(h.db.prepare('SELECT amount_cents FROM refund_requests').get().amount_cents, Math.round(Number(amount ?? '9.99') * 100));
    assert.equal(h.db.prepare('SELECT status FROM entitlements').get().status, 'revoked');
    assert.match(h.db.prepare("SELECT detail FROM refund_events WHERE event_type = 'refund_requested'").get().detail, /amount=/);
    await h.refund(event);
    assert.equal(h.providerRefunds.size, 1);
  } finally { h.db.close(); }
});

test('invalid refund amounts are rejected before provider calls or database writes', async () => {
  const h = harness();
  try {
    const order = await paidOrder(h);
    for (const amount of [0, -1, '10.00', '1.001', '', 'NaN', 'Infinity', '1e0', null, {}, true]) {
      await assert.rejects(h.refund({ params: { orderNo: order.orderNo }, body: { amount, reason: 'Customer requested refund' } }), (error) => error.statusCode === 400);
    }
    assert.equal(h.providerRefunds.size, 0);
    assert.equal(h.db.prepare('SELECT COUNT(*) AS count FROM refund_requests').get().count, 0);
    assert.equal(h.db.prepare('SELECT status FROM orders').get().status, 'paid');
  } finally { h.db.close(); }
});

test('manual partial refund records the selected amount without calling PayPal', async () => {
  const h = harness();
  try {
    const order = await paidOrder(h);
    await h.refund({ params: { orderNo: order.orderNo }, body: { amount: '3.50', reason: 'Merchant portal refund completed', method: 'manual', providerStatus: 'COMPLETED' } });
    assert.equal(h.providerRefunds.size, 0);
    assert.equal(h.db.prepare('SELECT amount_cents FROM refund_requests').get().amount_cents, 350);
    assert.equal(h.db.prepare('SELECT status FROM entitlements').get().status, 'revoked');
  } finally { h.db.close(); }
});

test('refund retry after an uncertain provider response keeps the amount and idempotency key', async () => {
  let fail = true;
  const h = harness({ afterRefund: () => { if (fail) throw new Error('Connection interrupted'); } });
  try {
    const order = await paidOrder(h);
    const event = { params: { orderNo: order.orderNo }, body: { amount: '2.35', reason: 'Customer requested refund' } };
    await assert.rejects(h.refund(event));
    await assert.rejects(h.refund({ ...event, body: { ...event.body, amount: '4.00' } }), (error) => error.statusCode === 409 && error.data.code === 'REFUND_RECONCILIATION_REQUIRED' && error.data.originalAmount === '2.35');
    await assert.rejects(h.refund({ ...event, body: { reason: event.body.reason, method: 'cancel' } }), (error) => error.statusCode === 409);
    fail = false;
    assert.equal((await h.refund(event)).data.status, 'refunded');
    assert.equal(h.providerRefunds.size, 1);
    assert.equal(h.db.prepare('SELECT amount_cents FROM refund_requests').get().amount_cents, 235);
  } finally { h.db.close(); }
});

for (const issue of ['INSUFFICIENT_FUNDS', 'REFUND_FAILED_INSUFFICIENT_FUNDS', 'REFUND_NOT_ALLOWED']) {
  for (const source of ['data', 'response']) test(`refund rejection ${issue} via ${source} reports the correct admin message`, async () => {
    const payload = { details: [{ issue: 'OTHER_DETAIL' }, { issue }] };
    const h = harness({ beforeRefund: () => {
      throw Object.assign(new Error('Refund rejected'), source === 'data'
        ? { statusCode: 422, data: payload }
        : { response: { status: 422, _data: payload } });
    } });
    try {
      const order = await paidOrder(h);
      const insufficientFunds = issue !== 'REFUND_NOT_ALLOWED';
      const message = 'PayPal 商户账户余额不足，无法完成退款。请补足余额后重试。';
      await assert.rejects(h.refund({ params: { orderNo: order.orderNo }, body: { amount: '9.99', reason: 'Customer requested refund' } }), (error) => {
        assert.equal(error.statusCode, 502);
        assert.equal(error.data.code, insufficientFunds ? 'PAYPAL_REFUND_INSUFFICIENT_FUNDS' : 'PAYPAL_PROVIDER_ERROR');
        assert.equal(error.data.message, insufficientFunds ? message : undefined);
        assert.equal(error.data.providerStatus, 422);
        assert.equal(error.data.providerDetail, `OTHER_DETAIL; ${issue}`);
        return true;
      });
      const refund = h.db.prepare('SELECT status, provider_status, error_message FROM refund_requests').get();
      assert.equal(refund.status, 'failed');
      assert.equal(refund.provider_status, 'REQUEST_REJECTED');
      if (insufficientFunds) {
        assert.equal(refund.error_message, message);
        assert.equal(h.db.prepare("SELECT detail FROM refund_events WHERE event_type = 'refund_attempt_failed'").get().detail, message);
        assert.equal((await h.adminOrders({ query: { environment: 'sandbox' } })).data.items[0].refund.errorMessage, message);
      }
      assert.equal(h.db.prepare('SELECT status FROM orders').get().status, 'paid');
      assert.equal(h.db.prepare('SELECT status FROM entitlements').get().status, 'granted');
      assert.equal(h.providerRefunds.size, 0);
    } finally { h.db.close(); }
  });
}

for (const amount of ['9.99', '0.66']) test(`cancel a rejected refund and reopen the same paid order for ${amount}`, async () => {
  let reject = true;
  const keys = [];
  const h = harness({ beforeRefund: (options) => {
    keys.push(options.headers['PayPal-Request-Id']);
    if (reject) throw Object.assign(new Error('Refund rejected'), { statusCode: 422, data: { details: [{ issue: 'INSUFFICIENT_FUNDS' }] } });
  } });
  try {
    const order = await paidOrder(h);
    const event = { params: { orderNo: order.orderNo }, body: { amount: '9.99', reason: 'Original customer refund reason' } };
    await assert.rejects(h.refund(event));
    assert.equal((await h.refund({ ...event, body: { method: 'cancel', reason: 'Close failed refund application' } })).data.status, 'cancelled');
    assert.equal(h.db.prepare('SELECT status FROM orders').get().status, 'paid');
    assert.equal(h.db.prepare('SELECT status FROM entitlements').get().status, 'granted');
    assert.equal(keys.length, 1);
    assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM refund_events WHERE event_type = 'refund_cancelled'").get().n, 1);
    reject = false;
    assert.equal((await h.refund({ ...event, body: { amount, reason: 'New partial refund application' } })).data.status, 'refunded');
    assert.notEqual(keys[0], keys[1]);
    assert.equal([...h.providerRefunds.values()][0].amount.value, amount);
    assert.match(h.db.prepare("SELECT detail FROM refund_events WHERE event_type = 'refund_requested'").get().detail, /Original customer refund reason; amount=9.99/);
    assert.equal(h.db.prepare('SELECT status FROM entitlements').get().status, 'revoked');
  } finally { h.db.close(); }
});

for (const providerStatus of ['FAILED', 'PENDING', 'COMPLETED']) test(`cancellation reconciles a previously failed refund now reported as ${providerStatus}`, async () => {
  let first = true;
  const h = harness({ afterRefund: (refund) => { if (first) { refund.status = 'FAILED'; first = false; } } });
  try {
    const order = await paidOrder(h);
    const event = { params: { orderNo: order.orderNo }, body: { amount: '1.00', reason: 'Customer requested refund' } };
    assert.equal((await h.refund(event)).data.status, 'failed');
    [...h.providerRefunds.values()][0].status = providerStatus;
    const cancel = { ...event, body: { method: 'cancel', reason: 'Close failed refund application' } };
    if (providerStatus === 'FAILED') {
      assert.equal((await h.refund(cancel)).data.status, 'cancelled');
      assert.equal((await h.refund({ ...event, body: { ...event.body, amount: '0.66' } })).data.status, 'refunded');
      assert.equal(h.providerRefunds.size, 2);
    } else {
      await assert.rejects(h.refund(cancel), (error) => error.statusCode === 409);
      assert.equal(h.providerRefunds.size, 1);
      assert.equal(h.db.prepare('SELECT status FROM orders').get().status, providerStatus === 'PENDING' ? 'refunding' : 'refunded');
    }
  } finally { h.db.close(); }
});

test('an unresolved refund on another paid order does not block a new refund', async () => {
  let fail = true;
  const h = harness({ afterRefund: () => { if (fail) throw new Error('Response lost'); } });
  try {
    const first = await paidOrder(h);
    await assert.rejects(h.refund({ params: { orderNo: first.orderNo }, body: { amount: '1.00', reason: 'First customer refund request' } }));
    h.db.exec("INSERT INTO users (user_id, email, created_at, updated_at, last_seen_at) VALUES ('other', 'other@example.com', 'now', 'now', 'now')");
    const second = (await h.create({ user: 'other', body: { seriesId: 's', paymentMethod: 'card' } })).data;
    h.providerOrders.get(second.paypalOrderId).status = 'APPROVED';
    await h.capture({ user: 'other', body: { paypalOrderId: second.paypalOrderId } });
    fail = false;
    assert.equal((await h.refund({ params: { orderNo: second.orderNo }, body: { amount: '0.66', reason: 'Second customer refund request' } })).data.status, 'refunded');
    assert.equal(h.db.prepare('SELECT status FROM refund_requests WHERE order_no = ?').get(first.orderNo).status, 'failed');
  } finally { h.db.close(); }
});

for (const evidence of ['missing', 'completed', 'pending', 'wrong_amount', 'wrong_capture', 'multiple']) test(`refund verification after a lost response handles ${evidence} evidence without submitting another refund`, async () => {
  let posts = 0;
  const h = harness({ beforeRefund: () => { posts++; }, afterRefund: () => { throw new Error('Response lost'); } });
  try {
    const order = await paidOrder(h);
    await assert.rejects(h.refund({ params: { orderNo: order.orderNo }, body: { amount: '0.66', reason: 'Customer requested refund' } }));
    const payments = h.providerOrders.get(order.paypalOrderId).purchase_units[0].payments;
    const refund = [...h.providerRefunds.values()][0];
    if (evidence !== 'missing') payments.refunds = [refund];
    if (evidence === 'pending') refund.status = 'PENDING';
    if (evidence === 'wrong_amount') refund.amount.value = '1.00';
    if (evidence === 'wrong_capture') payments.captures[0].id = 'OTHER-CAPTURE';
    if (evidence === 'multiple') payments.refunds.push({ ...refund, id: 'OTHER-REFUND' });
    if (evidence === 'completed') payments.captures[0].status = 'PARTIALLY_REFUNDED';
    if (evidence === 'wrong_capture') {
      await assert.rejects(h.verify({ params: { orderNo: order.orderNo }, context: {} }), (error) => error.data?.code === 'CAPTURE_ID_CONFLICT');
      assert.equal(posts, 1);
      assert.equal(h.db.prepare('SELECT paypal_refund_id FROM refund_requests').get().paypal_refund_id, null);
      return;
    }
    const result = (await h.verify({ params: { orderNo: order.orderNo }, context: {} })).data;
    assert.equal(posts, 1);
    assert.equal(result.refundAmount, '0.66');
    assert.equal(result.synchronized, evidence === 'completed');
    assert.equal(result.refundReconciliationRequired, evidence !== 'completed');
    if (['completed', 'pending'].includes(evidence)) {
      assert.equal(h.db.prepare('SELECT paypal_refund_id FROM refund_requests').get().paypal_refund_id, refund.id);
      assert.equal(result.refundStatus, evidence === 'completed' ? 'completed' : 'processing');
      assert.equal(h.db.prepare('SELECT status FROM entitlements').get().status, evidence === 'completed' ? 'revoked' : 'granted');
    } else {
      assert.match(result.message, /退款结果仍未确认/);
      assert.equal(h.db.prepare('SELECT paypal_refund_id FROM refund_requests').get().paypal_refund_id, null);
    }
  } finally { h.db.close(); }
});

test('verification recognizes a fully refunded capture even without refund details', async () => {
  const h = harness({ afterRefund: () => { throw new Error('Response lost'); } });
  try {
    const order = await paidOrder(h);
    await assert.rejects(h.refund({ params: { orderNo: order.orderNo }, body: { amount: '9.99', reason: 'Customer requested full refund' } }));
    h.providerOrders.get(order.paypalOrderId).purchase_units[0].payments.captures[0].status = 'REFUNDED';
    const result = (await h.verify({ params: { orderNo: order.orderNo }, context: {} })).data;
    assert.equal(result.refundStatus, 'completed');
    assert.equal(result.synchronized, true);
    assert.equal(result.refundReconciliationRequired, false);
    assert.equal(h.db.prepare('SELECT status FROM entitlements').get().status, 'revoked');
    assert.equal(h.providerRefunds.size, 1);
  } finally { h.db.close(); }
});

test('a rejected refund can be retried with a new amount and a new provider request ID', async () => {
  let reject = true;
  const keys = [];
  const h = harness({ beforeRefund: (options) => {
    keys.push(options.headers['PayPal-Request-Id']);
    if (reject) throw Object.assign(new Error('Refund rejected'), { statusCode: 422, data: { details: [{ issue: 'INSUFFICIENT_FUNDS' }] } });
  } });
  try {
    const order = await paidOrder(h);
    const event = { params: { orderNo: order.orderNo }, body: { amount: '9.99', reason: 'Customer requested refund' } };
    await assert.rejects(h.refund(event));
    assert.equal(h.db.prepare('SELECT provider_status FROM refund_requests').get().provider_status, 'REQUEST_REJECTED');
    reject = false;
    await h.refund({ ...event, body: { ...event.body, amount: '0.50' } });
    assert.notEqual(keys[0], keys[1]);
    assert.equal([...h.providerRefunds.values()][0].amount.value, '0.50');
    assert.equal(h.db.prepare('SELECT amount_cents FROM refund_requests').get().amount_cents, 50);
    assert.match(h.db.prepare("SELECT detail FROM refund_events WHERE event_type = 'refund_amount_changed'").get().detail, /9.99 -> 0.50/);
  } finally { h.db.close(); }
});

for (const issue of ['INSUFFICIENT_FUNDS', 'REFUND_FAILED_INSUFFICIENT_FUNDS']) test(`legacy failed requests with ${issue} allow amount changes`, async () => {
  const h = harness();
  try {
    const order = await paidOrder(h);
    h.db.prepare(`INSERT INTO refund_requests (id, order_no, capture_id, amount_cents, status, reason, requested_by, created_at, updated_at, attempt_count, provider_request_id, error_message)
      VALUES ('legacy-refund', ?, ?, 999, 'failed', 'Customer requested refund', 'admin', 'now', 'now', 1, 'old-key', ?)`).run(order.orderNo, `CAP-${order.paypalOrderId}`, `PayPal rejected the refund request: ${issue}`);
    await h.refund({ params: { orderNo: order.orderNo }, body: { amount: '0.50', reason: 'Customer requested partial refund' } });
    assert.equal(h.db.prepare('SELECT amount_cents FROM refund_requests').get().amount_cents, 50);
    assert.equal([...h.providerRefunds.values()][0].amount.value, '0.50');
  } finally { h.db.close(); }
});

for (const providerStatus of [null, 'UNKNOWN']) test(`legacy insufficient-funds refund with provider status ${providerStatus} can be verified, cancelled and reapplied`, async () => {
  const h = harness();
  try {
    const order = await paidOrder(h);
    h.db.prepare(`INSERT INTO refund_requests (id, order_no, capture_id, amount_cents, status, reason, requested_by, created_at, updated_at, attempt_count, provider_request_id, provider_status, error_message)
      VALUES ('legacy-refund', ?, ?, 100, 'failed', 'Original refund request', 'admin', 'now', 'now', 2, 'old-key', ?, 'PayPal rejected the refund request: REFUND_FAILED_INSUFFICIENT_FUNDS')`).run(order.orderNo, `CAP-${order.paypalOrderId}`, providerStatus);
    const event = { params: { orderNo: order.orderNo }, context: {} };
    const verified = (await h.verify(event)).data;
    assert.equal(verified.refundReconciliationRequired, false);
    assert.equal(verified.refundStatus, 'failed');
    assert.equal((await h.refund({ ...event, body: { method: 'cancel', reason: 'Close rejected refund application' } })).data.status, 'cancelled');
    assert.equal((await h.verify(event)).data.refundStatus, 'cancelled');
    assert.equal(h.providerRefunds.size, 0);
    assert.equal(h.db.prepare('SELECT status FROM entitlements').get().status, 'granted');
    await h.refund({ ...event, body: { amount: '0.66', reason: 'Reapply for partial refund' } });
    assert.equal([...h.providerRefunds.values()][0].amount.value, '0.66');
    assert.notEqual([...h.providerRefunds.keys()][0], 'old-key');
  } finally { h.db.close(); }
});

for (const providerStatus of ['FAILED', 'PENDING', 'COMPLETED']) test(`changing a failed refund amount reconciles provider status ${providerStatus}`, async () => {
  let first = true;
  const h = harness({ afterRefund: (refund) => {
    if (first) { refund.status = 'FAILED'; first = false; }
  } });
  try {
    const order = await paidOrder(h);
    const event = { params: { orderNo: order.orderNo }, body: { amount: '9.99', reason: 'Customer requested refund' } };
    await h.refund(event);
    [...h.providerRefunds.values()][0].status = providerStatus;
    const changed = { ...event, body: { ...event.body, amount: '0.50' } };
    if (providerStatus === 'FAILED') {
      await h.refund(changed);
      assert.equal(h.providerRefunds.size, 2);
      assert.equal(h.db.prepare('SELECT amount_cents FROM refund_requests').get().amount_cents, 50);
    } else {
      await assert.rejects(h.refund(changed), (error) => error.statusCode === 409);
      assert.equal(h.providerRefunds.size, 1);
      assert.equal(h.db.prepare('SELECT amount_cents FROM refund_requests').get().amount_cents, 999);
      assert.equal(h.db.prepare('SELECT status FROM orders').get().status, providerStatus === 'PENDING' ? 'refunding' : 'refunded');
    }
  } finally { h.db.close(); }
});

test('concurrent refund submissions with different amounts cannot overwrite the winning request', async () => {
  const h = harness();
  try {
    const order = await paidOrder(h);
    const results = await Promise.allSettled(['2.00', '3.00'].map((amount) => h.refund({ params: { orderNo: order.orderNo }, body: { amount, reason: 'Customer requested refund' } })));
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(h.providerRefunds.size, 1);
    assert.equal(h.db.prepare('SELECT amount_cents FROM refund_requests').get().amount_cents, Number([...h.providerRefunds.values()][0].amount.value) * 100);
  } finally { h.db.close(); }
});

for (const method of ['paypal', 'card', 'apple_pay']) test(`${method}: trusted order, retry, capture, webhook replay and refund`, async () => {
  const h = harness();
  try {
    const event = { body: { seriesId: 's', idempotencyKey: 'attempt', paymentMethod: method, amount: 0.01 } };
    const first = (await h.create(event)).data;
    assert.equal(first.amount, 9.99);
    assert.equal(first.paymentMethod, method);
    assert.equal(Boolean(first.approvalUrl), method === 'paypal');
    assert.equal((await h.create(event)).data.paypalOrderId, first.paypalOrderId);
    assert.equal(h.creates(), 1);
    assert.equal(h.db.prepare('SELECT COUNT(*) AS count FROM entitlements').get().count, 0);
    const provider = h.providerOrders.get(first.paypalOrderId);
    provider.status = 'APPROVED';
    assert.equal((await h.capture({ body: { paypalOrderId: first.paypalOrderId } })).data.status, 'paid');
    assert.equal(h.db.prepare('SELECT status FROM entitlements').get().status, 'granted');
    await h.paypal.applyVerifiedCapture({}, first.paypalOrderId, provider);
    await h.capture({ body: { paypalOrderId: first.paypalOrderId } });
    assert.equal(h.db.prepare('SELECT COUNT(*) AS count FROM entitlements').get().count, 1);
    assert.equal(h.captures(), 1);
    await h.paypal.applyVerifiedRefund({}, { captureId: `CAP-${first.paypalOrderId}`, paypalRefundId: 'REF-1', status: 'COMPLETED', source: 'paypal_webhook' });
    assert.equal(h.db.prepare('SELECT status FROM orders').get().status, 'refunded');
    assert.equal(h.db.prepare('SELECT status FROM entitlements').get().status, 'revoked');
  } finally { h.db.close(); }
});
test('method conflict preserves the original provider order and returns a cancellable reference', async () => {
  const h = harness();
  try {
    const order = (await h.create({ body: { seriesId: 's', paymentMethod: 'card' } })).data;
    await assert.rejects(h.create({ body: { seriesId: 's', paymentMethod: 'apple_pay' } }), (error) => error.data?.code === 'CHECKOUT_METHOD_CONFLICT' && error.data?.paypalOrderId === order.paypalOrderId);
    assert.equal(h.creates(), 1);
    await h.cancel({ body: { paypalOrderId: order.paypalOrderId } });
    const next = (await h.create({ body: { seriesId: 's', paymentMethod: 'apple_pay' } })).data;
    assert.equal(next.paymentMethod, 'apple_pay');
    assert.notEqual(next.paypalOrderId, order.paypalOrderId);
  } finally { h.db.close(); }
});
test('cancel reconciles an approved payment instead of releasing the purchase for another charge', async () => {
  const h = harness();
  try {
    const order = (await h.create({ body: { seriesId: 's', paymentMethod: 'apple_pay' } })).data;
    h.providerOrders.get(order.paypalOrderId).status = 'APPROVED';
    assert.equal((await h.cancel({ body: { paypalOrderId: order.paypalOrderId } })).data.status, 'paid');
    assert.equal((await h.create({ body: { seriesId: 's', paymentMethod: 'card' } })).data.status, 'paid');
    assert.equal(h.creates(), 1);
  } finally { h.db.close(); }
});
test('authorization, ownership and payment method validation run before provider operations', async () => {
  const h = harness();
  try {
    await assert.rejects(h.create({ user: false, body: { seriesId: 's' } }), (error) => error.statusCode === 401);
    await assert.rejects(h.create({ body: { seriesId: 's', paymentMethod: 'bank_transfer' } }), (error) => error.statusCode === 400);
    const order = (await h.create({ body: { seriesId: 's', paymentMethod: 'card' } })).data;
    await assert.rejects(h.capture({ user: 'other', body: { paypalOrderId: order.paypalOrderId } }), (error) => error.statusCode === 404);
    await assert.rejects(h.cancel({ user: 'other', body: { paypalOrderId: order.paypalOrderId } }), (error) => error.statusCode === 404);
    assert.equal(h.captures(), 0);
  } finally { h.db.close(); }
});

test('PayPal cancellation redirect verifies payment and replays without another capture', async () => {
  const h = harness();
  try {
    const order = (await h.create({ body: { seriesId: 's', paymentMethod: 'paypal' } })).data;
    const event = { query: { orderNo: order.orderNo, token: order.paypalOrderId } };
    h.providerOrders.get(order.paypalOrderId).status = 'APPROVED';
    for (let replay = 0; replay < 2; replay++) {
      const result = await h.cancelRedirect(event);
      assert.equal(result.statusCode, 302);
      assert.match(result.location, /payment=success&/);
    }
    assert.equal(h.captures(), 1);
    assert.equal(h.db.prepare('SELECT status FROM orders').get().status, 'paid');
    assert.equal(h.db.prepare('SELECT status FROM entitlements').get().status, 'granted');
  } finally { h.db.close(); }
});

test('PayPal cancellation redirect validates its token and cancels an unapproved checkout', async () => {
  const h = harness();
  try {
    const order = (await h.create({ body: { seriesId: 's', paymentMethod: 'paypal' } })).data;
    await assert.rejects(h.cancelRedirect({ query: { orderNo: order.orderNo, token: 'wrong-token' } }),
      (error) => error.statusCode === 400);
    assert.equal(h.db.prepare('SELECT status FROM orders').get().status, 'processing');
    const result = await h.cancelRedirect({ query: { orderNo: order.orderNo, token: order.paypalOrderId } });
    assert.match(result.location, /payment=cancelled&/);
    assert.equal(h.db.prepare('SELECT status FROM orders').get().status, 'cancelled');
    assert.equal(h.captures(), 0);
  } finally { h.db.close(); }
});

test('provider outage during cancellation keeps the checkout reserved for reconciliation', async () => {
  const h = harness({ beforeRead: () => { throw new Error('Provider unavailable'); } });
  try {
    const order = (await h.create({ body: { seriesId: 's', paymentMethod: 'paypal' } })).data;
    const result = await h.cancelRedirect({ query: { orderNo: order.orderNo, token: order.paypalOrderId } });
    assert.match(result.location, /payment=processing&/);
    await assert.rejects(h.cancel({ body: { paypalOrderId: order.paypalOrderId } }));
    assert.equal(h.db.prepare('SELECT status FROM orders').get().status, 'processing');
    await assert.rejects(h.create({ body: { seriesId: 's', paymentMethod: 'card' } }),
      (error) => error.data?.code === 'CHECKOUT_METHOD_CONFLICT');
    assert.equal(h.creates(), 1);
  } finally { h.db.close(); }
});

for (const method of ['paypal', 'card', 'apple_pay']) test(`${method}: lost capture response reconciles one charge and one entitlement`, async () => {
  const h = harness({ afterCapture: () => { throw new Error('Capture response lost'); } });
  try {
    const order = (await h.create({ body: { seriesId: 's', paymentMethod: method } })).data;
    h.providerOrders.get(order.paypalOrderId).status = 'APPROVED';
    assert.equal((await h.capture({ body: { paypalOrderId: order.paypalOrderId } })).data.status, 'paid');
    assert.equal((await h.cancel({ body: { paypalOrderId: order.paypalOrderId } })).data.status, 'paid');
    assert.equal(h.captures(), 1);
    assert.equal(h.db.prepare("SELECT COUNT(*) AS count FROM entitlements WHERE status = 'granted'").get().count, 1);
  } finally { h.db.close(); }
});

test('pending provider capture cannot be cancelled or replaced', async () => {
  const h = harness();
  try {
    const order = (await h.create({ body: { seriesId: 's', paymentMethod: 'apple_pay' } })).data;
    const provider = h.providerOrders.get(order.paypalOrderId);
    provider.status = 'COMPLETED';
    provider.purchase_units[0].payments = { captures: [{ id: 'CAP-PENDING', status: 'PENDING', amount: provider.purchase_units[0].amount }] };
    await assert.rejects(h.cancel({ body: { paypalOrderId: order.paypalOrderId } }),
      (error) => error.data?.code === 'PAYMENT_CAPTURE_UNCONFIRMED');
    const result = await h.cancelRedirect({ query: { orderNo: order.orderNo, token: order.paypalOrderId } });
    assert.match(result.location, /payment=processing&/);
    assert.equal(h.db.prepare('SELECT status FROM orders').get().status, 'processing');
    assert.equal(h.db.prepare('SELECT COUNT(*) AS count FROM entitlements').get().count, 0);
    assert.equal(h.captures(), 0);
  } finally { h.db.close(); }
});

test('switching methods during provider creation preserves the original request and recovers a cancellation reference', async () => {
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  const payloads = [];
  const h = harness({ afterCreate: async (_order, payload) => {
    payloads.push(payload);
    if (payloads.length === 1) { started.resolve(); await release.promise; }
  } });
  const firstRequest = h.create({ body: { seriesId: 's', paymentMethod: 'paypal', idempotencyKey: 'first' } });
  try {
    await started.promise;
    assert.equal(h.db.prepare('SELECT paypal_order_id FROM orders').get().paypal_order_id, null);
    await assert.rejects(h.create({ body: { seriesId: 's', paymentMethod: 'card', idempotencyKey: 'second' } }),
      (error) => error.data?.code === 'CHECKOUT_METHOD_CONFLICT' && Boolean(error.data.paypalOrderId));
    release.resolve();
    const first = (await firstRequest).data;
    assert.equal(first.paymentMethod, 'paypal');
    assert.equal(h.db.prepare('SELECT payment_method FROM orders').get().payment_method, 'paypal');
    assert.deepEqual(payloads[0], payloads[1]);
    assert.equal(h.providerOrders.size, 1);
    await h.cancel({ body: { paypalOrderId: first.paypalOrderId } });
    const next = (await h.create({ body: { seriesId: 's', paymentMethod: 'card' } })).data;
    assert.equal(next.paymentMethod, 'card');
    assert.notEqual(next.paypalOrderId, first.paypalOrderId);
  } finally { release.resolve(); await firstRequest.catch(() => {}); h.db.close(); }
});
