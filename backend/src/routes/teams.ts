import {
  getTeam,
  getTeamView,
  joinTeam,
  removeTeamMember,
  updateTeamConfig,
  type TeamConfig,
} from '../data/teams.js';
import { requireProfile } from '../data/users.js';
import { requireWorkspaceRole } from '../data/workspaces.js';
import { HttpError, type Route } from '../lib/router.js';
import { isValidReminderTime } from '../lib/time.js';

export function parseTeamConfig(body: unknown): TeamConfig {
  const input = (body ?? {}) as Record<string, unknown>;
  const { questions, workdays, reminderTime } = input;
  if (
    !Array.isArray(questions) ||
    questions.length !== 3 ||
    !questions.every(
      (question) => typeof question === 'string' && question.trim() && question.length <= 200,
    )
  ) {
    throw new HttpError(
      400,
      'bad_request',
      'questions must be 3 non-empty strings of at most 200 characters',
    );
  }
  if (
    !Array.isArray(workdays) ||
    workdays.length === 0 ||
    !workdays.every((day) => Number.isInteger(day) && day >= 0 && day <= 6) ||
    new Set(workdays).size !== workdays.length
  ) {
    throw new HttpError(400, 'bad_request', 'workdays must be distinct days 0 (Sunday) to 6');
  }
  if (typeof reminderTime !== 'string' || !isValidReminderTime(reminderTime)) {
    throw new HttpError(400, 'bad_request', 'reminderTime must be HH:MM on a 15-minute boundary');
  }
  return {
    questions: questions.map((question: string) => question.trim()),
    workdays: [...workdays].sort((first, second) => first - second),
    reminderTime,
  };
}

export const teamRoutes: Route[] = [
  {
    method: 'GET',
    pattern: '/teams/:teamId',
    auth: true,
    handler: async (request) => {
      const view = await getTeamView(request.params.teamId);
      const role = await requireWorkspaceRole(view.team.workspaceId, request.userId!).catch(() => {
        throw new HttpError(404, 'team_not_found', 'team not found');
      });
      return { status: 200, body: { ...view, role } };
    },
  },
  {
    method: 'PUT',
    pattern: '/teams/:teamId/config',
    auth: true,
    handler: async (request) => {
      const config = parseTeamConfig(request.body);
      const team = await getTeam(request.params.teamId);
      await requireWorkspaceRole(team.workspaceId, request.userId!, 'owner');
      return { status: 200, body: { team: await updateTeamConfig(team.teamId, config) } };
    },
  },
  {
    method: 'POST',
    pattern: '/teams/:teamId/join',
    auth: true,
    handler: async (request) => {
      const team = await getTeam(request.params.teamId);
      await requireWorkspaceRole(team.workspaceId, request.userId!);
      const profile = await requireProfile(request.userId!);
      await joinTeam(team, request.userId!, profile);
      return { status: 200, body: { joined: true } };
    },
  },
  {
    method: 'DELETE',
    pattern: '/teams/:teamId/members/:userId',
    auth: true,
    handler: async (request) => {
      const team = await getTeam(request.params.teamId);
      const role = await requireWorkspaceRole(team.workspaceId, request.userId!);
      if (request.params.userId !== request.userId && role !== 'owner') {
        throw new HttpError(403, 'forbidden', 'only the workspace owner can remove others');
      }
      await removeTeamMember(team.teamId, request.params.userId);
      return { status: 200, body: { removed: true } };
    },
  },
];
