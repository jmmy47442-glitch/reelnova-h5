import { ok } from '~/server/utils/response';
import { saveHomeSections, type StoredHomeSection } from '~/server/utils/home-config';

const isValidSection = (value: StoredHomeSection) => value && typeof value.id === 'string' && typeof value.title === 'string'
  && typeof value.subtitle === 'string' && typeof value.source === 'string' && typeof value.enabled === 'boolean'
  && Number.isInteger(value.count) && value.count >= 1 && value.count <= 50
  && Array.isArray(value.itemIds) && value.itemIds.every((id) => typeof id === 'string');

export default defineEventHandler(async (event) => {
  const body = await readBody<{ items?: StoredHomeSection[] }>(event);
  if (!Array.isArray(body?.items) || !body.items.every(isValidSection)) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid home section configuration' });
  }
  return ok({ items: await saveHomeSections(event, body.items) });
});
