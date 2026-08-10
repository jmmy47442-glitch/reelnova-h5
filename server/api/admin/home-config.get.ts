import { ok } from '~/server/utils/response';
import { getHomeSections } from '~/server/utils/home-config';

export default defineEventHandler(async (event) => ok({ items: await getHomeSections(event) }));
