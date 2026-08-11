import { ok } from '~/server/utils/response';
import { capturePayPalOrder, applyVerifiedCapture } from '~/server/utils/paypal';
import { d1First } from '~/server/utils/cloudflare-d1';
import { getUserSession } from '~/server/utils/user-auth';
import type { OrderStatus } from '~/types/content';

export default defineEventHandler(async (event) => {
  const session = await getUserSession(event);
  if (!session) throw createError({ statusCode: 401, statusMessage: 'Login required' });
  const body = await readBody<{ paypalOrderId?: string }>(event);
  const paypalOrderId = body?.paypalOrderId?.trim() || '';
  if (!paypalOrderId || paypalOrderId.length > 120) throw createError({ statusCode: 400, statusMessage: 'PayPal order is required' });
  const order = await d1First<{ order_no: string; status: OrderStatus }>(event,
    'SELECT order_no, status FROM orders WHERE paypal_order_id = ? AND user_id = ?', [paypalOrderId, session.userId]);
  if (!order) throw createError({ statusCode: 404, statusMessage: 'Order not found' });
  if (order.status === 'paid') return ok({ orderNo: order.order_no, status: 'paid' as const });
  if (!['pending', 'processing'].includes(order.status)) throw createError({
    statusCode: 409,
    statusMessage: 'This order can no longer be paid',
    data: { code: 'ORDER_NOT_PAYABLE', orderNo: order.order_no, status: order.status },
  });
  const capture = await capturePayPalOrder(event, paypalOrderId);
  const applied = await applyVerifiedCapture(event, paypalOrderId, capture);
  return ok({ orderNo: applied.order_no, status: 'paid' as const });
});
