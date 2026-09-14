export type PaymentMethod = 'paypal' | 'card' | 'apple_pay';

export const buildPayPalOrderRequest = (input: {
  orderNo: string; seriesTitle: string; amount: string;
  returnUrl: string; cancelUrl: string; paymentMethod?: PaymentMethod;
}) => ({
  intent: 'CAPTURE',
  purchase_units: [{
    reference_id: input.orderNo, invoice_id: input.orderNo,
    description: `ReelNova: ${input.seriesTitle}`,
    amount: { currency_code: 'USD', value: input.amount },
  }],
  ...((input.paymentMethod || 'paypal') === 'paypal' ? {
    payment_source: { paypal: { experience_context: {
      brand_name: 'ReelNova', user_action: 'PAY_NOW', shipping_preference: 'NO_SHIPPING',
      return_url: input.returnUrl, cancel_url: input.cancelUrl,
    } } },
  } : input.paymentMethod === 'card' ? {
    payment_source: { card: { attributes: { verification: { method: 'SCA_WHEN_REQUIRED' } } } },
  } : {}),
});
