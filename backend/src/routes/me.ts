import type { Route } from '../lib/router.js';

export const meRoutes: Route[] = [
  {
    method: 'GET',
    pattern: '/me',
    auth: true,
    handler: async (request) => ({
      status: 200,
      body: { userId: request.userId, email: request.email },
    }),
  },
];
