import { ok } from '~/server/utils/response';
import { d1First } from '~/server/utils/cloudflare-d1';
import { applyPayPalPaymentTerminalState } from '~/server/utils/paypal';
import { getUserSession } from '~/server/utils/user-auth';

export default defineEventHandler(async (event) => {
  const session = await getUserSession(event);
  if (!session) throw createError({ statusCode: 401, statusMessage: 'Login required' });
  const body = await readBody<{ paypalOrderId?: string }>(event);
  const paypalOrderId = body.paypalOrderId?.trim() || '';
  if (!paypalOrderId || paypalOrderId.length > 120) throw createError({ statusCode: 400, statusMessage: 'PayPal order is required' });
  const order = await d1First<{ order_no: string; status: string }>(event,
    'SELECT order_no, status FROM orders WHERE paypal_order_id = ? AND user_id = ?', [paypalOrderId, session.userId]);
  if (!order) throw createError({ statusCode: 404, statusMessage: 'Order not found' });
  if (['pending', 'processing'].includes(order.status)) {
    await applyPayPalPaymentTerminalState(event, { paypalOrderId, status: 'cancelled', note: 'Payment cancelled by user' });
  }
  return ok({ orderNo: order.order_no, status: order.status === 'paid' ? 'paid' as const : 'cancelled' as const });
});
