import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isCancelledPayPalOrderStatus,
  isCompletedCaptureStatus,
  isDefinitiveCaptureFailure,
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
