import { getUserHome, saveProfile } from '../data/users.js';
import { HttpError, requireString, type Route } from '../lib/router.js';
import { isValidTimeZone } from '../lib/time.js';

export const meRoutes: Route[] = [
  {
    method: 'GET',
    pattern: '/me',
    auth: true,
    handler: async (request) => {
      const home = await getUserHome(request.userId!);
      return { status: 200, body: { userId: request.userId, email: request.email, ...home } };
    },
  },
  {
    method: 'PUT',
    pattern: '/me',
    auth: true,
    handler: async (request) => {
      const name = requireString(request.body, 'name', 80);
      const timezone = requireString(request.body, 'timezone', 64);
      if (!isValidTimeZone(timezone)) {
        throw new HttpError(400, 'bad_request', 'timezone is not a valid IANA zone');
      }
      await saveProfile(request.userId!, request.email, { name, timezone });
      return { status: 200, body: { profile: { name, timezone } } };
    },
  },
];
