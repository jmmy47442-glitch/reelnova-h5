export type ReportingEnvironment = 'production' | 'sandbox';

export const parseReportingEnvironment = (value: unknown): ReportingEnvironment => {
  if (value === undefined || value === 'production') return 'production';
  if (value === 'sandbox') return 'sandbox';
  throw createError({ statusCode: 400, statusMessage: 'Invalid reporting environment' });
};

// Only interpolate server-owned aliases and the validated environment enum.
// Fixture records remain available in the database, but never count as sales.
export const reportingOrders = (alias = 'o', environment: ReportingEnvironment = 'production') =>
  `${alias}.paypal_environment = '${environment}'
    AND ${alias}.order_no NOT LIKE 'RN-ACCEPT-%'
    AND COALESCE(${alias}.capture_id, '') NOT LIKE 'CAPTURE-ACCEPT-%'`;

// Refunding/refunded orders still had a successful capture. Refunds are a
// separate cash flow, deducted once using their actual completed amount.
export const capturedOrders = (alias = 'o') =>
  `${alias}.status IN ('paid', 'refunding', 'refunded')
    AND NULLIF(${alias}.capture_id, '') IS NOT NULL AND ${alias}.callback_at IS NOT NULL`;
