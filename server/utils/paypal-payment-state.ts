export const terminalCaptureFailureStatuses = ['DECLINED', 'DENIED', 'FAILED'] as const;

export const normalizePayPalStatus = (status: unknown) => String(status || '').trim().toUpperCase();

export const isCompletedCaptureStatus = (status: unknown) => normalizePayPalStatus(status) === 'COMPLETED';

export const isTerminalCaptureFailureStatus = (status: unknown) =>
  terminalCaptureFailureStatuses.includes(normalizePayPalStatus(status) as typeof terminalCaptureFailureStatuses[number]);

export const isCancelledPayPalOrderStatus = (status: unknown) => normalizePayPalStatus(status) === 'VOIDED';

export const paypalCheckoutLifetimeMs = 3 * 60 * 60 * 1000;

export const isPayPalCheckoutExpired = (
  createdAt: string,
  now = Date.now(),
  lifetimeMs = paypalCheckoutLifetimeMs,
) => {
  const createdAtMs = Date.parse(createdAt);
  return Number.isFinite(createdAtMs) && createdAtMs <= now - lifetimeMs;
};

const terminalCaptureIssues = new Set([
  'INSTRUMENT_DECLINED',
  'PAYER_CANNOT_PAY',
  'PAYMENT_DENIED',
  'PAYMENT_SOURCE_DECLINED',
  'TRANSACTION_REFUSED',
]);

const collectIssueCodes = (value: unknown): string[] => {
  if (!value || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  const details = Array.isArray(record.details) ? record.details : [];
  const ownIssue = typeof record.issue === 'string' ? [record.issue.toUpperCase()] : [];
  return ownIssue.concat(details.flatMap(collectIssueCodes));
};

export const payPalErrorIssueCodes = (error: unknown): string[] => {
  if (!error || typeof error !== 'object') return [];
  const record = error as Record<string, unknown>;
  return [...new Set([
    ...collectIssueCodes(record),
    ...collectIssueCodes(record.data),
    ...collectIssueCodes(record.response),
    ...collectIssueCodes((record.response as Record<string, unknown> | undefined)?._data),
  ])];
};

export const isDefinitiveCaptureFailure = (error: unknown) =>
  payPalErrorIssueCodes(error).some((issue) => terminalCaptureIssues.has(issue));

export const isMissingPayPalResource = (error: unknown) => {
  if (!error || typeof error !== 'object') return false;
  const record = error as Record<string, unknown>;
  const response = record.response as Record<string, unknown> | undefined;
  const status = Number(record.statusCode || record.status || response?.status || 0);
  return status === 404 || payPalErrorIssueCodes(error).some((issue) =>
    issue === 'INVALID_RESOURCE_ID' || issue === 'RESOURCE_NOT_FOUND');
};

export const isPayPalTimeoutError = (error: unknown) => {
  if (!error || typeof error !== 'object') return false;
  const record = error as Record<string, unknown>;
  const code = String(record.code || (record.cause as Record<string, unknown> | undefined)?.code || '').toUpperCase();
  const name = String(record.name || (record.cause as Record<string, unknown> | undefined)?.name || '').toUpperCase();
  const message = String(record.message || '').toLowerCase();
  return ['ABORT_ERR', 'ECONNABORTED', 'ETIMEDOUT', 'FETCH_ERROR'].includes(code)
    || name.includes('TIMEOUT')
    || message.includes('timed out')
    || message.includes('timeout');
};
