import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

const migration = readFileSync(new URL('../migrations/0020_playback_security.sql', import.meta.url), 'utf8');

const createDatabase = () => {
  const database = new DatabaseSync(':memory:');
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE users (user_id TEXT PRIMARY KEY);
  `);
  database.exec(migration);
  return database;
};

const insertSession = (database, { sessionId, userId = 'user-1', deviceHash, status = 'active', lastSeenAt = '2026-08-28T10:00:00.000Z' }) => {
  database.prepare('INSERT OR IGNORE INTO users (user_id) VALUES (?)').run(userId);
  database.prepare(`INSERT INTO playback_sessions
    (session_id, user_id, series_id, episode_no, device_hash, ip_hash, user_agent_hash, status,
     token_count, event_count, created_at, last_seen_at, expires_at, last_token_at)
    VALUES (?, ?, 'series-1', 1, ?, 'ip-1', 'ua-1', ?, 1, 0, ?, ?, '2026-08-28T12:00:00.000Z', ?)`)
    .run(sessionId, userId, deviceHash, status, lastSeenAt, lastSeenAt, lastSeenAt);
};

test('playback security migration creates durable session, rate limit, and event ledgers', () => {
  const database = createDatabase();
  const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'playback_%' ORDER BY name").all().map((row) => row.name);
  assert.deepEqual(tables, ['playback_rate_limits', 'playback_security_events', 'playback_sessions']);

  const indexes = database.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_playback_%' ORDER BY name").all().map((row) => row.name);
  assert.ok(indexes.includes('idx_playback_sessions_user_active'));
  assert.ok(indexes.includes('idx_playback_sessions_device_active'));
  assert.ok(indexes.includes('idx_playback_rate_limits_updated'));
  assert.ok(indexes.includes('idx_playback_security_events_type_created'));
  database.close();
});

test('active playback is capped to two devices while the same device can renew', () => {
  const database = createDatabase();
  insertSession(database, { sessionId: '11111111-1111-4111-8111-111111111111', deviceHash: 'device-a' });
  insertSession(database, { sessionId: '22222222-2222-4222-8222-222222222222', deviceHash: 'device-b' });

  const canRenewSameDevice = database.prepare(`SELECT
    EXISTS (SELECT 1 FROM playback_sessions WHERE user_id = ? AND device_hash = ? AND status = 'active')
      OR (SELECT COUNT(DISTINCT device_hash) FROM playback_sessions
        WHERE user_id = ? AND status = 'active' AND last_seen_at > ?) < ? AS allowed`)
    .get('user-1', 'device-a', 'user-1', '2026-08-28T09:30:00.000Z', 2);
  assert.equal(canRenewSameDevice.allowed, 1);

  const thirdDevice = database.prepare(`SELECT
    EXISTS (SELECT 1 FROM playback_sessions WHERE user_id = ? AND device_hash = ? AND status = 'active')
      OR (SELECT COUNT(DISTINCT device_hash) FROM playback_sessions
        WHERE user_id = ? AND status = 'active' AND last_seen_at > ?) < ? AS allowed`)
    .get('user-1', 'device-c', 'user-1', '2026-08-28T09:30:00.000Z', 2);
  assert.equal(thirdDevice.allowed, 0);
  database.close();
});

test('rate limit buckets increment within a fixed window and record blocking metadata', () => {
  const database = createDatabase();
  const consume = database.prepare(`INSERT INTO playback_rate_limits
    (bucket_key, window_started_at, request_count, blocked_until, updated_at)
    VALUES ('bucket-1', ?, 1, NULL, '2026-08-28T10:00:00.000Z')
    ON CONFLICT(bucket_key) DO UPDATE SET
      window_started_at = excluded.window_started_at,
      request_count = CASE WHEN playback_rate_limits.window_started_at = excluded.window_started_at
        THEN playback_rate_limits.request_count + 1 ELSE 1 END,
      blocked_until = CASE WHEN playback_rate_limits.window_started_at = excluded.window_started_at
        THEN playback_rate_limits.blocked_until ELSE NULL END,
      updated_at = excluded.updated_at`);
  consume.run(1000);
  consume.run(1000);
  consume.run(2000);
  const row = database.prepare('SELECT window_started_at, request_count, blocked_until FROM playback_rate_limits WHERE bucket_key = ?').get('bucket-1');
  assert.equal(row.window_started_at, 2000);
  assert.equal(row.request_count, 1);
  assert.equal(row.blocked_until, null);

  database.prepare('UPDATE playback_rate_limits SET blocked_until = ? WHERE bucket_key = ?').run(3000, 'bucket-1');
  assert.equal(database.prepare('SELECT blocked_until FROM playback_rate_limits WHERE bucket_key = ?').get('bucket-1').blocked_until, 3000);
  database.close();
});

test('security events keep hashed identifiers and reject invalid event metadata', () => {
  const database = createDatabase();
  database.prepare('INSERT INTO users (user_id) VALUES (?)').run('user-1');
  database.prepare(`INSERT INTO playback_security_events
    (id, session_id, user_id, series_id, episode_no, event_type, device_hash, ip_hash, detail, created_at)
    VALUES ('security-1', 'session-1', 'user-1', 'series-1', 1, 'rate_limit_block', 'device-hash', 'ip-hash', '{}', '2026-08-28T10:00:00.000Z')`).run();
  const event = database.prepare('SELECT event_type, device_hash, ip_hash FROM playback_security_events WHERE id = ?').get('security-1');
  assert.deepEqual({ ...event }, { event_type: 'rate_limit_block', device_hash: 'device-hash', ip_hash: 'ip-hash' });
  assert.throws(() => database.prepare(`INSERT INTO playback_security_events
    (id, episode_no, event_type, created_at) VALUES ('security-bad', 0, 'bad', '2026-08-28T10:00:00.000Z')`).run(), /CHECK constraint failed/);
  database.close();
});
