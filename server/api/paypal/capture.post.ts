import { ok } from '~/server/utils/response';
import {
  applyPayPalPaymentTerminalState,
  applyVerifiedCapture,
  capturePayPalOrder,
  reconcilePayPalOrder,
  recordPayPalProcessingIssue,
  type PayPalEnvironment,
} from '~/server/utils/paypal';
import { isDefinitiveCaptureFailure, isPayPalTimeoutError, isTerminalCaptureFailureStatus } from '~/server/utils/paypal-payment-state';
import { d1First } from '~/server/utils/cloudflare-d1';
import { getUserSession } from '~/server/utils/user-auth';
import type { OrderStatus } from '~/types/content';

export default defineEventHandler(async (event) => {
  const session = await getUserSession(event);
  if (!session) throw createError({ statusCode: 401, statusMessage: 'Login required' });
  const body = await readBody<{ paypalOrderId?: string }>(event);
  const paypalOrderId = body?.paypalOrderId?.trim() || '';
  if (!paypalOrderId || paypalOrderId.length > 120) throw createError({ statusCode: 400, statusMessage: 'PayPal order is required' });
  const order = await d1First<{ order_no: string; status: OrderStatus; paypal_environment: PayPalEnvironment | null }>(event,
    'SELECT order_no, status, paypal_environment FROM orders WHERE paypal_order_id = ? AND user_id = ?', [paypalOrderId, session.userId]);
  if (!order) throw createError({ statusCode: 404, statusMessage: 'Order not found' });
  if (order.status === 'paid') return ok({ orderNo: order.order_no, status: 'paid' as const });
  if (!['pending', 'processing'].includes(order.status)) throw createError({
    statusCode: 409,
    statusMessage: 'This order can no longer be paid',
    data: { code: 'ORDER_NOT_PAYABLE', orderNo: order.order_no, status: order.status },
  });
  try {
    const capture = await capturePayPalOrder(event, paypalOrderId, order.paypal_environment || undefined);
    const payment = capture.purchase_units?.[0]?.payments?.captures?.[0];
    if (payment && isTerminalCaptureFailureStatus(payment.status)) {
      await applyPayPalPaymentTerminalState(event, {
        paypalOrderId,
        status: 'failed',
        note: `PayPal capture ${payment.id} failed: ${String(payment.status).toUpperCase()}`,
      });
      throw createError({ statusCode: 422, statusMessage: 'PayPal declined the payment', data: { code: 'PAYMENT_CAPTURE_DENIED' } });
    }
    const applied = await applyVerifiedCapture(event, paypalOrderId, capture);
    return ok({ orderNo: applied.order_no, status: 'paid' as const });
  } catch (error) {
    const errorCode = (error as { data?: { code?: string } }).data?.code;
    if (errorCode === 'PAYMENT_CAPTURE_DENIED') throw error;
    if (isDefinitiveCaptureFailure(error)) {
      await applyPayPalPaymentTerminalState(event, { paypalOrderId, status: 'failed', note: 'PayPal declined the capture request' });
      throw createError({ statusCode: 422, statusMessage: 'PayPal declined the payment', data: { code: 'PAYMENT_CAPTURE_DENIED' } });
    }
    try {
      const reconciled = await reconcilePayPalOrder(event, {
        paypalOrderId,
        environment: order.paypal_environment || undefined,
        captureApproved: true,
      });
      if (reconciled === 'paid') return ok({ orderNo: order.order_no, status: 'paid' as const });
      if (reconciled === 'failed' || reconciled === 'cancelled') {
        throw createError({ statusCode: 422, statusMessage: 'PayPal did not complete the payment', data: { code: 'PAYMENT_CAPTURE_FAILED' } });
      }
    } catch (verificationError) {
      const verificationCode = (verificationError as { data?: { code?: string } }).data?.code;
      if (verificationCode === 'PAYMENT_CAPTURE_FAILED') throw verificationError;
      if (isDefinitiveCaptureFailure(verificationError)) {
        await applyPayPalPaymentTerminalState(event, { paypalOrderId, status: 'failed', note: 'PayPal declined the capture request during reconciliation' });
        throw createError({ statusCode: 422, statusMessage: 'PayPal declined the payment', data: { code: 'PAYMENT_CAPTURE_FAILED' } });
      }
    }
    const timedOut = isPayPalTimeoutError(error);
    await recordPayPalProcessingIssue(event, paypalOrderId, timedOut
      ? 'PayPal capture request timed out; awaiting provider reconciliation'
      : `PayPal capture confirmation failed: ${error instanceof Error ? error.message : 'unknown provider error'}`);
    throw createError({
      statusCode: timedOut ? 504 : 502,
      statusMessage: timedOut ? 'Payment confirmation timed out' : 'PayPal capture could not be confirmed',
      data: { code: timedOut ? 'PAYMENT_CONFIRMATION_TIMEOUT' : 'PAYMENT_CAPTURE_UNCONFIRMED', orderNo: order.order_no, status: 'processing' },
    });
  }
});
