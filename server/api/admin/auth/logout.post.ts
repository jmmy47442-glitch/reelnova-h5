import { clearAdminSession } from '../../../utils/admin-auth';
import { ok } from '../../../utils/response';

export default defineEventHandler((event) => {
  clearAdminSession(event);
  return ok({ loggedOut: true });
});
