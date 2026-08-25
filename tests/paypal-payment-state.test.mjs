import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isCancelledPayPalOrderStatus,
  isCompletedCaptureStatus,
  isDefinitiveCaptureFailure,
  isMissingPayPalResource,
  isPayPalCheckoutExpired,
  isPayPalTimeoutError,
  isTerminalCaptureFailureStatus,
  payPalErrorIssueCodes,
} from '../server/utils/paypal-payment-state.ts';

test('normalizes completed, denied and voided PayPal states', () => {
  assert.equal(isCompletedCaptureStatus('completed'), true);
  assert.equal(isTerminalCaptureFailureStatus('DENIED'), true);
  assert.equal(isTerminalCaptureFailureStatus('DECLINED'), true);
  assert.equal(isTerminalCaptureFailureStatus('FAILED'), true);
  assert.equal(isTerminalCaptureFailureStatus('PENDING'), false);
  assert.equal(isCancelledPayPalOrderStatus('voided'), true);
});

test('extracts terminal capture issues from PayPal fetch errors', () => {
  const error = { response: { _data: { details: [{ issue: 'INSTRUMENT_DECLINED' }] } } };
  assert.deepEqual(payPalErrorIssueCodes(error), ['INSTRUMENT_DECLINED']);
  assert.equal(isDefinitiveCaptureFailure(error), true);
  assert.equal(isDefinitiveCaptureFailure({ data: { details: [{ issue: 'ORDER_ALREADY_CAPTURED' }] } }), false);
});

test('recognizes provider timeout variants', () => {
  assert.equal(isPayPalTimeoutError({ cause: { name: 'TimeoutError' } }), true);
  assert.equal(isPayPalTimeoutError({ code: 'ETIMEDOUT' }), true);
  assert.equal(isPayPalTimeoutError(new Error('request timed out')), true);
  assert.equal(isPayPalTimeoutError(new Error('provider rejected request')), false);
});

test('recognizes expired checkout sessions at the PayPal three-hour boundary', () => {
  const now = Date.parse('2026-08-25T12:00:00.000Z');
  assert.equal(isPayPalCheckoutExpired('2026-08-25T09:00:00.000Z', now), true);
  assert.equal(isPayPalCheckoutExpired('2026-08-25T09:00:00.001Z', now), false);
  assert.equal(isPayPalCheckoutExpired('invalid-date', now), false);
});

test('recognizes PayPal orders that no longer exist', () => {
  assert.equal(isMissingPayPalResource({ response: { status: 404 } }), true);
  assert.equal(isMissingPayPalResource({ response: { _data: { details: [{ issue: 'INVALID_RESOURCE_ID' }] } } }), true);
  assert.equal(isMissingPayPalResource({ statusCode: 502, data: { details: [{ issue: 'RESOURCE_NOT_FOUND' }] } }), true);
  assert.equal(isMissingPayPalResource({ response: { status: 500 } }), false);
});
