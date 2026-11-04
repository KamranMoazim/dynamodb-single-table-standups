import { createTeam } from '../data/teams.js';
import { requireProfile } from '../data/users.js';
import {
  createWorkspace,
  getWorkspaceView,
  joinByInvite,
  requireWorkspaceRole,
} from '../data/workspaces.js';
import { requireString, type Route } from '../lib/router.js';

export const workspaceRoutes: Route[] = [
  {
    method: 'POST',
    pattern: '/workspaces',
    auth: true,
    handler: async (request) => {
      const name = requireString(request.body, 'name', 80);
      const profile = await requireProfile(request.userId!);
      const workspace = await createWorkspace(request.userId!, profile, name);
      return { status: 201, body: { workspace } };
    },
  },
  {
    method: 'GET',
    pattern: '/workspaces/:workspaceId',
    auth: true,
    handler: async (request) => ({
      status: 200,
      body: await getWorkspaceView(request.params.workspaceId, request.userId!),
    }),
  },
  {
    method: 'POST',
    pattern: '/invites/:code/join',
    auth: true,
    handler: async (request) => {
      const profile = await requireProfile(request.userId!);
      const workspace = await joinByInvite(request.params.code, request.userId!, profile);
      return { status: 200, body: { workspace } };
    },
  },
  {
    method: 'POST',
    pattern: '/workspaces/:workspaceId/teams',
    auth: true,
    handler: async (request) => {
      const name = requireString(request.body, 'name', 80);
      await requireWorkspaceRole(request.params.workspaceId, request.userId!, 'owner');
      const profile = await requireProfile(request.userId!);
      const team = await createTeam(request.params.workspaceId, name, request.userId!, profile);
      return { status: 201, body: { team } };
    },
  },
];
