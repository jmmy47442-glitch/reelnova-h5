import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { buildPayPalOrderRequest } from '../server/utils/paypal-checkout.ts';

const input = { orderNo: 'RN-TEST', seriesTitle: 'Example', amount: '9.99', returnUrl: 'https://example.com/return', cancelUrl: 'https://example.com/cancel' };
test('wallet, card and Apple Pay keep the same trusted price and invoice', () => {
  for (const paymentMethod of ['paypal', 'card', 'apple_pay']) {
    const payload = buildPayPalOrderRequest({ ...input, paymentMethod });
    assert.equal(payload.intent, 'CAPTURE');
    assert.deepEqual(payload.purchase_units[0].amount, { currency_code: 'USD', value: '9.99' });
    assert.equal(payload.purchase_units[0].invoice_id, input.orderNo);
  }
});
test('card requests require SCA without sending card data or forcing PayPal login', () => {
  const payload = buildPayPalOrderRequest({ ...input, paymentMethod: 'card' });
  assert.deepEqual(payload.payment_source, { card: { attributes: { verification: { method: 'SCA_WHEN_REQUIRED' } } } });
});
test('Apple Pay order accepts a token later, while default PayPal retains its redirect', () => {
  assert.equal(buildPayPalOrderRequest({ ...input, paymentMethod: 'apple_pay' }).payment_source, undefined);
  const paypal = buildPayPalOrderRequest(input).payment_source.paypal;
  assert.equal(paypal.experience_context.return_url, input.returnUrl);
  assert.equal(paypal.experience_context.shipping_preference, 'NO_SHIPPING');
});
test('all migrations preserve historical PayPal orders and constrain new payment methods', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const directory = new URL('../migrations/', import.meta.url);
    for (const file of readdirSync(directory).filter((name) => name.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(file, directory), 'utf8'));
    const columns = db.prepare('PRAGMA table_info(orders)').all();
    assert.equal(columns.find((column) => column.name === 'payment_method').dflt_value, "'paypal'");
    db.exec("INSERT INTO users (user_id, email, created_at, updated_at, last_seen_at) VALUES ('u', 'u@example.com', 'now', 'now', 'now')");
    const insert = db.prepare(`INSERT INTO orders (order_no, series_id, series_slug, series_title, user_id, amount_cents, currency, status, created_at, updated_at, paypal_environment, business_idempotency_key, price_version, pricing_snapshot_json, activity_snapshot_json, payment_method) VALUES (?, ?, 'test', 'Test', 'u', 999, 'USD', 'processing', 'now', 'now', 'sandbox', ?, 'v1', '{}', '{}', ?)`);
    for (const method of ['paypal', 'card', 'apple_pay']) {
      insert.run(`RN-${method}`, method, method, method);
      db.prepare("UPDATE orders SET status = 'paid' WHERE order_no = ?").run(`RN-${method}`);
      assert.equal(db.prepare('SELECT status FROM entitlements WHERE order_no = ?').get(`RN-${method}`).status, 'granted');
      db.prepare("UPDATE orders SET status = 'refunded' WHERE order_no = ?").run(`RN-${method}`);
      assert.equal(db.prepare('SELECT status FROM entitlements WHERE order_no = ?').get(`RN-${method}`).status, 'revoked');
    }
    assert.throws(() => insert.run('RN-invalid', 'invalid', 'invalid', 'bank_transfer'), /CHECK constraint/);
  } finally { db.close(); }
});
