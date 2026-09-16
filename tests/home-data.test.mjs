import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const load = (path, imports = {}, globals = {}) => {
  const source = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  runInNewContext(code, { exports, require: (name) => {
    if (!(name in imports)) throw new Error(`Unexpected import: ${name}`);
    return imports[name];
  }, ...globals });
  return exports;
};
const { countHomeUpdates } = load('utils/home-updates.ts');
const story = (id) => ({ id, title: id, slug: id, genres: [], cast: [], episodes: [], updatedAt: '2026-09-16', views: 0 });
const home = () => {
  const a = story('a'), b = story('b');
  return { featured: a, tabs: ['Popular', 'New'], sections: [
    { id: 'popular', title: 'Popular', subtitle: '', items: [a, b] },
    { id: 'new', title: 'New', subtitle: '', items: [b, a] },
  ], generatedAt: 'before' };
};

test('home update notice ignores fetch timestamps, counters and viewing progress', () => {
  const before = home(), after = structuredClone(before);
  after.generatedAt = 'after';
  after.featured.views = 100;
  after.featured.progress = 90;
  after.featured.updatedAt = '2026-09-17';
  assert.equal(countHomeUpdates(before, after), 0);
});
test('two edited stories count as two updates even across several shelves', () => {
  const before = home(), after = home();
  after.featured.title = 'Edited A';
  after.sections[0].items[1].coverUrl = '/changed.jpg';
  assert.equal(countHomeUpdates(before, after), 2);
  assert.equal(countHomeUpdates(after, after), 0);
});
test('ranking, shelf order, added and removed stories are detectable', () => {
  const before = home(), after = home();
  after.sections[0].items.reverse();
  assert.equal(countHomeUpdates(before, after), 1);
  const reordered = home(); reordered.sections.reverse();
  assert.equal(countHomeUpdates(before, reordered), 1);
  const added = home(); added.sections[0].items.push(story('c'));
  assert.equal(countHomeUpdates(before, added), 1);
  assert.equal(countHomeUpdates(added, before), 1);
});

test('Popular uses stored starts, ignores heartbeats/retries and ranks before limiting', async () => {
  const database = new DatabaseSync(':memory:');
  try {
    const directory = new URL('../migrations/', import.meta.url);
    for (const file of readdirSync(directory).filter((name) => name.endsWith('.sql')).sort()) database.exec(readFileSync(new URL(file, directory), 'utf8'));
    database.exec("INSERT INTO users (user_id, email, created_at, updated_at, last_seen_at) VALUES ('u', 'u@example.test', 'now', 'now', 'now')");
    const insert = database.prepare(`INSERT OR IGNORE INTO playback_events
      (event_id, session_id, user_id, series_id, series_title, episode_no, event_type, position_seconds, duration_seconds, created_at)
      VALUES (?, ?, 'u', ?, ?, 1, ?, 0, 60, '2026-09-16')`);
    insert.run('a', 'session-a', 's12', 's12', 'start');
    insert.run('retry', 'session-a', 's12', 's12', 'start');
    insert.run('b', 'session-b', 's12', 's12', 'start');
    for (let i = 0; i < 10; i++) insert.run(`heartbeat-${i}`, 'session-c', 's0', 's0', 'heartbeat');
    const d1 = { hasD1Connection: () => true, d1All: async (_event, sql, params = []) => database.prepare(sql).all(...params) };
    const ranking = load('server/utils/content-ranking.ts', { './cloudflare-d1': d1, './reporting-orders': load('server/utils/reporting-orders.ts') });
    const runtime = load('server/utils/series-runtime.ts', {
      '~/server/utils/cloudflare-d1': d1,
      '~/server/utils/user-auth': { getUserSession: async () => null },
    });
    const catalogue = Array.from({ length: 13 }, (_, i) => ({ ...story(`s${i}`), views: i === 0 ? 999999 : 0 }));
    const api = load('server/api/home.get.ts', {
      '~/server/utils/response': { ok: (data) => ({ data }) },
      '~/server/utils/series-runtime': runtime,
      '~/server/utils/home-config': { getHomeSections: async () => [] },
      '~/server/utils/managed-content': { getPublicSeries: async () => catalogue },
      '~/server/utils/content-ranking': ranking,
    }, { defineEventHandler: (fn) => fn, setHeader: () => {}, createError: (input) => Object.assign(new Error(input.statusMessage), input) }).default;
    const result = (await api({})).data;
    assert.equal(result.sections[0].items.length, 12);
    assert.equal(result.sections[0].items[0].id, 's12');
    assert.equal(result.sections[0].items[0].views, 2);
    assert.equal(result.sections[0].items.find((item) => item.id === 's0').views, 0);
    assert.equal(result.featured.id, 's12');
  } finally { database.close(); }
});
test('failed configuration writes are never exposed as saved in-memory state', async () => {
  const storage = load('server/utils/system-config.ts', { './cloudflare-d1': {
    d1First: async () => ({ payload: '[{"id":"persisted"}]' }),
    d1Run: async () => { throw new Error('Database unavailable'); },
  } });
  const config = load('server/utils/home-config.ts', { './system-config': storage });
  await assert.rejects(config.saveHomeSections({}, [{ id: 'unsaved', itemIds: [] }]), /Database unavailable/);
  assert.equal((await config.getHomeSections({}))[0].id, 'persisted');
});
