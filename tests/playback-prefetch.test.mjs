import assert from 'node:assert/strict';
import test from 'node:test';
import { canPrefetchPlayback, playbackProfile, handoffPlayback, takePlaybackHandoff, prefetchPlaybackStart } from '../utils/playback-prefetch.ts';

test('prefetch skips slow connections, cellular, save-data and hidden pages', t => {
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const priorDocument = globalThis.document;
  const connection = {};
  Object.defineProperty(globalThis, 'navigator', { value: { connection }, configurable: true });
  globalThis.document = { visibilityState: 'visible' };
  t.after(() => {
    if (prior) Object.defineProperty(globalThis, 'navigator', prior); else delete globalThis.navigator;
    globalThis.document = priorDocument;
  });
  assert.equal(canPrefetchPlayback(), true);
  for (const setting of [{ saveData: true }, { effectiveType: '3g' }, { type: 'cellular' }, { downlink: 0.5 }]) {
    Object.assign(connection, setting);
    assert.equal(playbackProfile(), 'mobile');
    assert.equal(canPrefetchPlayback(), false);
    for (const key of Object.keys(connection)) delete connection[key];
  }
  globalThis.document.visibilityState = 'hidden';
  assert.equal(canPrefetchPlayback(), false);
});

test('navigation reuses exactly one matching unexpired authorization and its episode session', () => {
  const value = { slug: 'series', episodeNo: 2, sessionId: 'next-session',
    grant: { signedUrl: 'https://media.test/signed', expiresAt: new Date(Date.now() + 120000).toISOString() } };
  handoffPlayback(value);
  assert.equal(takePlaybackHandoff('series', 2).sessionId, 'next-session');
  assert.equal(takePlaybackHandoff('series', 2), undefined);
  handoffPlayback(value);
  assert.equal(takePlaybackHandoff('other', 2), undefined);
  assert.equal(takePlaybackHandoff('series', 2), undefined);
  handoffPlayback({ ...value, grant: { ...value.grant, expiresAt: new Date(Date.now() + 1000).toISOString() } });
  assert.equal(takePlaybackHandoff('series', 2), undefined);
});

test('client warm requests are bounded and cancel a server that ignores Range', async t => {
  const previous = globalThis.fetch;
  t.after(() => { globalThis.fetch = previous; });
  let cancelled = false;
  globalThis.fetch = async (_url, options) => {
    assert.equal(options.headers.Range, 'bytes=0-524287');
    assert.equal(options.cache, 'no-store');
    return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 200 });
  };
  await prefetchPlaybackStart('https://media.test/signed', new AbortController().signal);
  assert.equal(cancelled, true);
  globalThis.fetch = async () => new Response(new Uint8Array(16), {
    status: 206, headers: { 'content-range': 'bytes 0-15/16', 'content-length': '16' },
  });
  await prefetchPlaybackStart('https://media.test/signed', new AbortController().signal);
});
