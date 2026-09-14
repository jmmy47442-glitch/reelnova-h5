import { getActivePayPalEnvironment } from '~/server/utils/paypal';

// Official PayPal association files, hosted verbatim for Apple's domain validation.
// Each checkout domain must also be registered in the matching PayPal app dashboard.
export default defineEventHandler(async (event) => {
  const environment = await getActivePayPalEnvironment(event);
  const association = await useStorage('assets:server').getItem<string>(`apple-pay/${environment}.txt`);
  if (!association) throw createError({ statusCode: 503, statusMessage: 'Apple Pay domain association is unavailable' });
  // Apple validates the association file as a downloaded asset and may reject
  // text content types or redirects during merchant-domain registration.
  setHeader(event, 'Content-Type', 'application/octet-stream');
  setHeader(event, 'Cache-Control', 'no-store');
  return association;
});
