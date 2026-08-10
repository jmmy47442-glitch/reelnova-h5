import { clearUserSession } from '../../utils/user-auth';
import { ok } from '../../utils/response';

export default defineEventHandler((event) => {
  clearUserSession(event);
  return ok({ loggedOut: true });
});
