import { ok } from '~/server/utils/response';

export default defineEventHandler(async (event) => {
  const body = await readBody<{ lookup?: string }>(event);
  if (!body.lookup?.trim()) throw createError({ statusCode: 400, statusMessage: 'Lookup is required' });
  return ok({ restored: 2 });
});
