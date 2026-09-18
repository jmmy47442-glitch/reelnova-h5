export default defineEventHandler(() => {
  throw createError({ statusCode: 410, statusMessage: 'Stream integration has been retired' });
});
