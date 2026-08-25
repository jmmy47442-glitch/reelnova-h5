export const terminalCaptureFailureStatuses = ['DECLINED', 'DENIED', 'FAILED'] as const;

export const normalizePayPalStatus = (status: unknown) => String(status || '').trim().toUpperCase();

export const isCompletedCaptureStatus = (status: unknown) => normalizePayPalStatus(status) === 'COMPLETED';

export const isTerminalCaptureFailureStatus = (status: unknown) =>
  terminalCaptureFailureStatuses.includes(normalizePayPalStatus(status) as typeof terminalCaptureFailureStatuses[number]);

export const isCancelledPayPalOrderStatus = (status: unknown) => normalizePayPalStatus(status) === 'VOIDED';

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
