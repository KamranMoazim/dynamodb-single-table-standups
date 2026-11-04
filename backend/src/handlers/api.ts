import { createRouter } from '../lib/router.js';
import { checkinRoutes } from '../routes/checkins.js';
import { healthRoutes } from '../routes/health.js';
import { meRoutes } from '../routes/me.js';
import { teamRoutes } from '../routes/teams.js';
import { workspaceRoutes } from '../routes/workspaces.js';

export const handler = createRouter([
  ...healthRoutes,
  ...meRoutes,
  ...workspaceRoutes,
  ...teamRoutes,
  ...checkinRoutes,
]);
