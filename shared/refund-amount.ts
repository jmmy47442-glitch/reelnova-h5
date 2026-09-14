export const parseRefundAmountCents = (amount: unknown): number | null => {
  if (typeof amount !== 'number' && typeof amount !== 'string') return null;
  const value = String(amount).trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(value)) return null;
  const [whole, fraction = ''] = value.split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
};
