import { verifyMediaWorkerRequest } from '~/server/utils/internal-worker-auth';
import { reconcileStalePayPalOrders } from '~/server/utils/paypal';

export default defineEventHandler(async (event) => {
  const rawBody = await readRawBody(event, 'utf8') || '';
  if (!await verifyMediaWorkerRequest(event, rawBody)) throw createError({ statusCode: 401, statusMessage: 'Invalid payment reconciliation signature' });
  const payments = await reconcileStalePayPalOrders(event);
  return { ok: true, payments, completedAt: new Date().toISOString() };
});
