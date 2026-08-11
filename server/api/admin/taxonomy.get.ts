import { ok } from '~/server/utils/response';
import { getTaxonomyConfig } from '~/server/utils/managed-content';

export default defineEventHandler(async (event) => ok({ items: await getTaxonomyConfig(event) }));
