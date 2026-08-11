import { ok } from '~/server/utils/response';
import { getManagedSeries, toAdminSeries } from '~/server/utils/managed-content';

export default defineEventHandler(async (event) => ok({
  items: (await getManagedSeries(event)).map(toAdminSeries),
  generatedAt: new Date().toISOString(),
}));
