import { createRouter } from '../lib/router.js';
import { healthRoutes } from '../routes/health.js';
import { meRoutes } from '../routes/me.js';

export const handler = createRouter([...healthRoutes, ...meRoutes]);
