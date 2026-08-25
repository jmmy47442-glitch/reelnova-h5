import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

const migration = readFileSync(new URL('../migrations/0019_entitlement_lifecycle.sql', import.meta.url), 'utf8');

const createDatabase = (path = ':memory:') => {
  const database = new DatabaseSync(path);
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE users (user_id TEXT PRIMARY KEY);
    CREATE TABLE orders (
      order_no TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      series_id TEXT NOT NULL,
      status TEXT NOT NULL,
      callback_at TEXT,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(user_id)
    );
    CREATE TABLE entitlements (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      series_id TEXT NOT NULL,
      order_no TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('granted', 'revoked')),
      granted_at TEXT NOT NULL,
      revoked_at TEXT,
      UNIQUE(user_id, series_id),
      FOREIGN KEY(user_id) REFERENCES users(user_id),
      FOREIGN KEY(order_no) REFERENCES orders(order_no)
    );
  `);
  database.exec(migration);
  return database;
};

const insertOrder = (database, orderNo, userId, seriesId, status = 'processing') => {
  database.prepare('INSERT OR IGNORE INTO users (user_id) VALUES (?)').run(userId);
  database.prepare(`INSERT INTO orders (order_no, user_id, series_id, status, updated_at)
    VALUES (?, ?, ?, ?, '2026-08-25T10:00:00.000Z')`).run(orderNo, userId, seriesId, status);
};

test('repeated payment success grants exactly one durable entitlement', () => {
  const database = createDatabase();
  insertOrder(database, 'RN-ONE', 'user-1', 'series-1');
  const markPaid = database.prepare(`UPDATE orders SET status = 'paid', callback_at = COALESCE(callback_at, ?), updated_at = ?
    WHERE order_no = ?`);

  markPaid.run('2026-08-25T10:01:00.000Z', '2026-08-25T10:01:00.000Z', 'RN-ONE');
  markPaid.run('2026-08-25T10:02:00.000Z', '2026-08-25T10:02:00.000Z', 'RN-ONE');

  const rows = database.prepare('SELECT * FROM entitlements WHERE user_id = ? AND series_id = ?').all('user-1', 'series-1');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].order_no, 'RN-ONE');
  assert.equal(rows[0].status, 'granted');
  assert.equal(rows[0].granted_at, '2026-08-25T10:01:00.000Z');
  database.close();
});

test('entitlement remains available after a database reconnect and account login', () => {
  const directory = mkdtempSync(join(tmpdir(), 'reelnova-entitlement-'));
  const databasePath = join(directory, 'reelnova.sqlite');
  try {
    let database = createDatabase(databasePath);
    insertOrder(database, 'RN-PERSISTED', 'account-1', 'series-1');
    database.prepare("UPDATE orders SET status = 'paid', callback_at = updated_at WHERE order_no = ?").run('RN-PERSISTED');
    database.close();

    database = new DatabaseSync(databasePath);
    const entitlement = database.prepare(`SELECT status FROM entitlements
      WHERE user_id = ? AND series_id = ? AND status = 'granted'`).get('account-1', 'series-1');
    assert.equal(entitlement?.status, 'granted');
    database.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('completed refund atomically revokes access and retries stay revoked', () => {
  const database = createDatabase();
  insertOrder(database, 'RN-REFUND', 'user-1', 'series-1');
  database.prepare("UPDATE orders SET status = 'paid', callback_at = updated_at WHERE order_no = ?").run('RN-REFUND');

  const refund = database.prepare("UPDATE orders SET status = 'refunded', updated_at = ? WHERE order_no = ?");
  refund.run('2026-08-25T11:00:00.000Z', 'RN-REFUND');
  refund.run('2026-08-25T11:01:00.000Z', 'RN-REFUND');

  const entitlement = database.prepare('SELECT status, revoked_at FROM entitlements WHERE order_no = ?').get('RN-REFUND');
  assert.equal(entitlement?.status, 'revoked');
  assert.equal(entitlement?.revoked_at, '2026-08-25T11:00:00.000Z');
  const playable = database.prepare(`SELECT 1 FROM entitlements
    WHERE user_id = ? AND series_id = ? AND status = 'granted'`).get('user-1', 'series-1');
  assert.equal(playable, undefined);
  database.close();
});

test('a later paid order can restore access without an old refund revoking it', () => {
  const database = createDatabase();
  insertOrder(database, 'RN-FIRST', 'user-1', 'series-1');
  database.prepare("UPDATE orders SET status = 'paid' WHERE order_no = ?").run('RN-FIRST');
  database.prepare("UPDATE orders SET status = 'refunded' WHERE order_no = ?").run('RN-FIRST');

  insertOrder(database, 'RN-SECOND', 'user-1', 'series-1');
  database.prepare("UPDATE orders SET status = 'paid' WHERE order_no = ?").run('RN-SECOND');
  database.prepare("UPDATE orders SET status = 'refunded' WHERE order_no = ?").run('RN-FIRST');

  const rows = database.prepare('SELECT order_no, status FROM entitlements WHERE user_id = ? AND series_id = ?').all('user-1', 'series-1');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].order_no, 'RN-SECOND');
  assert.equal(rows[0].status, 'granted');
  database.close();
});

test('refunding one of two captured orders preserves one entitlement from the other', () => {
  const database = createDatabase();
  insertOrder(database, 'RN-FIRST', 'user-1', 'series-1');
  insertOrder(database, 'RN-SECOND', 'user-1', 'series-1');
  database.prepare("UPDATE orders SET status = 'paid' WHERE order_no = ?").run('RN-FIRST');
  database.prepare("UPDATE orders SET status = 'paid' WHERE order_no = ?").run('RN-SECOND');

  assert.equal(database.prepare(`SELECT COUNT(*) AS total FROM entitlements
    WHERE user_id = ? AND series_id = ? AND status = 'granted'`).get('user-1', 'series-1').total, 1);
  database.prepare("UPDATE orders SET status = 'refunded' WHERE order_no = ?").run('RN-FIRST');

  const entitlement = database.prepare('SELECT order_no, status FROM entitlements WHERE user_id = ? AND series_id = ?').get('user-1', 'series-1');
  assert.equal(entitlement?.order_no, 'RN-SECOND');
  assert.equal(entitlement?.status, 'granted');
  database.close();
});

test('payment entitlement cannot be granted without a matching paid order', () => {
  const database = createDatabase();
  insertOrder(database, 'RN-PENDING', 'user-1', 'series-1');
  assert.throws(() => database.prepare(`INSERT INTO entitlements
    (id, user_id, series_id, order_no, status, granted_at) VALUES (?, ?, ?, ?, 'granted', ?)`)
    .run('forged', 'user-1', 'series-1', 'RN-PENDING', '2026-08-25T10:00:00.000Z'),
  /granted entitlement requires a matching paid order/);
  database.close();
});
