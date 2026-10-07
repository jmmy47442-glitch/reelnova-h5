import assert from 'node:assert/strict';
import test from 'node:test';
import { isPublicUserRoute } from '../utils/user-route-access.ts';

test('catalogue, guest tabs, and episode discovery routes are public', () => {
  for (const path of ['/', '/explore', '/library', '/profile', '/series/second-chance', '/watch/second-chance/1', '/terms', '/login', '/register']) {
    assert.equal(isPublicUserRoute(path), true, `${path} should be public`);
  }
});

test('account detail and administration routes still require authentication', () => {
  for (const path of ['/library/orders', '/profile/orders', '/profile/history', '/admin', '/admin/system']) {
    assert.equal(isPublicUserRoute(path), false, `${path} should be protected`);
  }
});
