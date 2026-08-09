export const useFormatters = () => {
  const compactNumber = new Intl.NumberFormat('en-US', {
    notation: 'compact',
    maximumFractionDigits: 1,
  });

  const currency = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  });

  return {
    formatViews: (value: number) => compactNumber.format(value),
    formatPrice: (value: number) => currency.format(value),
  };
};
