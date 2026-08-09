export default defineEventHandler((event) => {
  if (!event.path.startsWith('/api/admin')) return;
  const config = useRuntimeConfig(event);
  if (String(config.cloudflareAccessRequired) !== 'true') return;
  // Cloudflare Access validates the JWT at the edge and forwards this assertion header.
  if (!getHeader(event, 'cf-access-jwt-assertion')) throw createError({ statusCode: 401, statusMessage: 'Cloudflare Access authentication required' });
});
