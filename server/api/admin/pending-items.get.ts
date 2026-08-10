import { ok } from '~/server/utils/response';
import { d1First } from '~/server/utils/cloudflare-d1';
import type { AdminPendingItem, AdminPendingItemsResponse } from '~/types/admin';

interface PendingRow {
  count: number;
  latest_at: string | null;
}

const countOrders = (event: Parameters<typeof d1First>[0], statuses: string[]) => d1First<PendingRow>(
  event,
  `SELECT COUNT(*) AS count, MAX(updated_at) AS latest_at FROM orders WHERE status IN (${statuses.map(() => '?').join(', ')})`,
  statuses,
);

export default defineEventHandler(async (event) => {
  const [awaitingOrders, refundingOrders, riskOrders, failedWebhooks] = await Promise.all([
    countOrders(event, ['pending', 'processing']),
    countOrders(event, ['refunding']),
    countOrders(event, ['risk_review']),
    d1First<PendingRow>(event, "SELECT COUNT(*) AS count, MAX(received_at) AS latest_at FROM paypal_webhook_events WHERE processing_status = 'failed'"),
  ]);

  const items: AdminPendingItem[] = [];
  const addItem = (row: PendingRow | null, item: Omit<AdminPendingItem, 'count' | 'latestAt'>) => {
    const count = Number(row?.count || 0);
    if (count > 0) items.push({ ...item, count, latestAt: row?.latest_at || null });
  };

  addItem(awaitingOrders, {
    id: 'orders-awaiting-confirmation',
    title: '笔订单等待确认',
    description: '检查 PayPal capture 与回调状态',
    severity: 'warning',
    to: '/admin/orders',
  });
  addItem(refundingOrders, {
    id: 'orders-refunding',
    title: '笔订单等待退款处理',
    description: '核对退款状态并同步权益',
    severity: 'warning',
    to: '/admin/orders',
  });
  addItem(riskOrders, {
    id: 'orders-risk-review',
    title: '笔订单需要风控审核',
    description: '检查回调金额、币种与订单快照',
    severity: 'danger',
    to: '/admin/orders',
  });
  addItem(failedWebhooks, {
    id: 'paypal-webhooks-failed',
    title: '条 PayPal Webhook 处理失败',
    description: '检查失败原因并重新核验相关订单',
    severity: 'danger',
    to: '/admin/system',
  });

  items.sort((a, b) => (b.latestAt || '').localeCompare(a.latestAt || ''));
  const data: AdminPendingItemsResponse = {
    connected: true,
    generatedAt: new Date().toISOString(),
    total: items.reduce((sum, item) => sum + item.count, 0),
    items,
  };
  return ok(data);
});
