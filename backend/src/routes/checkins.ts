import {
  REACTIONS,
  addComment,
  createCheckin,
  getCheckin,
  getFeed,
  getHistory,
  getOpenBlockers,
  requireCheckin,
  resolveBlocker,
  setReaction,
  updateCheckin,
  type CheckinInput,
} from '../data/checkins.js';
import { getTeam, getTeamView, isTeamMember, type Team } from '../data/teams.js';
import { requireProfile } from '../data/users.js';
import { requireWorkspaceRole, type Role } from '../data/workspaces.js';
import { HttpError, requireString, type ApiRequest, type Route } from '../lib/router.js';
import { isValidDate, localDate, weekdayOf } from '../lib/time.js';

const MAX_ANSWER = 1000;
const MAX_BLOCKER = 500;
const MAX_COMMENT = 500;

export function parseCheckin(body: unknown): CheckinInput {
  const { answers, blocker } = (body ?? {}) as Record<string, unknown>;
  if (
    !Array.isArray(answers) ||
    answers.length !== 3 ||
    !answers.every((answer) => typeof answer === 'string' && answer.length <= MAX_ANSWER)
  ) {
    throw new HttpError(
      400,
      'bad_request',
      `answers must be 3 strings of at most ${MAX_ANSWER} characters`,
    );
  }
  const trimmed = answers.map((answer: string) => answer.trim());
  if (trimmed.every((answer) => !answer)) {
    throw new HttpError(400, 'bad_request', 'answer at least one question');
  }
  if (
    blocker !== undefined &&
    blocker !== null &&
    (typeof blocker !== 'string' || blocker.length > MAX_BLOCKER)
  ) {
    throw new HttpError(
      400,
      'bad_request',
      `blocker must be a string of at most ${MAX_BLOCKER} characters`,
    );
  }
  return {
    answers: trimmed,
    blocker: typeof blocker === 'string' && blocker.trim() ? blocker.trim() : null,
  };
}

async function teamAccess(request: ApiRequest): Promise<{ team: Team; role: Role }> {
  const team = await getTeam(request.params.teamId);
  const role = await requireWorkspaceRole(team.workspaceId, request.userId!).catch(() => {
    throw new HttpError(404, 'team_not_found', 'team not found');
  });
  return { team, role };
}

async function requireTeamMember(team: Team, userId: string): Promise<void> {
  if (!(await isTeamMember(team.teamId, userId))) {
    throw new HttpError(403, 'not_team_member', 'join the team first');
  }
}

async function requireTeammateOrOwner(team: Team, role: Role, userId: string): Promise<void> {
  if (role !== 'owner') {
    await requireTeamMember(team, userId);
  }
}

function dateParam(request: ApiRequest): string {
  if (!isValidDate(request.params.date)) {
    throw new HttpError(400, 'bad_request', 'date must be YYYY-MM-DD');
  }
  return request.params.date;
}

const checkinPath = '/teams/:teamId/checkins/:date/:userId';

export const checkinRoutes: Route[] = [
  {
    method: 'POST',
    pattern: '/teams/:teamId/checkins',
    auth: true,
    handler: async (request) => {
      const input = parseCheckin(request.body);
      const { team } = await teamAccess(request);
      await requireTeamMember(team, request.userId!);
      const profile = await requireProfile(request.userId!);
      const date = localDate(profile.timezone);
      const checkin = await createCheckin(team.teamId, date, request.userId!, profile.name, input);
      return { status: 201, body: { checkin } };
    },
  },
  {
    method: 'GET',
    pattern: '/teams/:teamId/checkins/today',
    auth: true,
    handler: async (request) => {
      const { team } = await teamAccess(request);
      const profile = await requireProfile(request.userId!);
      const date = localDate(profile.timezone);
      return {
        status: 200,
        body: { date, checkin: await getCheckin(team.teamId, date, request.userId!, true) },
      };
    },
  },
  {
    method: 'PUT',
    pattern: '/teams/:teamId/checkins/today',
    auth: true,
    handler: async (request) => {
      const input = parseCheckin(request.body);
      const { team } = await teamAccess(request);
      const profile = await requireProfile(request.userId!);
      const checkin = await updateCheckin(
        team.teamId,
        localDate(profile.timezone),
        request.userId!,
        input,
      );
      return { status: 200, body: { checkin } };
    },
  },
  {
    method: 'GET',
    pattern: '/teams/:teamId/feed',
    auth: true,
    handler: async (request) => {
      const { team } = await teamAccess(request);
      let date = request.query.date;
      if (date === undefined) {
        date = localDate((await requireProfile(request.userId!)).timezone);
      } else if (!isValidDate(date)) {
        throw new HttpError(400, 'bad_request', 'date must be YYYY-MM-DD');
      }
      const [checkins, { members }] = await Promise.all([
        getFeed(team.teamId, date),
        getTeamView(team.teamId),
      ]);
      const authors = new Set(checkins.map((checkin) => checkin.userId));
      const missing = members
        .filter((member) => !authors.has(member.userId))
        .map((member) => ({ userId: member.userId, name: member.name }));
      return {
        status: 200,
        body: { date, isWorkday: team.workdays.includes(weekdayOf(date)), checkins, missing },
      };
    },
  },
  {
    method: 'POST',
    pattern: `${checkinPath}/comments`,
    auth: true,
    handler: async (request) => {
      const text = requireString(request.body, 'text', MAX_COMMENT);
      const date = dateParam(request);
      const { team, role } = await teamAccess(request);
      await requireTeammateOrOwner(team, role, request.userId!);
      await requireCheckin(team.teamId, date, request.params.userId);
      const profile = await requireProfile(request.userId!);
      const comment = await addComment(
        team.teamId,
        date,
        request.params.userId,
        request.userId!,
        profile.name,
        text,
      );
      return { status: 201, body: { comment } };
    },
  },
  ...(['PUT', 'DELETE'] as const).map(
    (method): Route => ({
      method,
      pattern: `${checkinPath}/reactions/:emoji`,
      auth: true,
      handler: async (request) => {
        if (!REACTIONS.includes(request.params.emoji)) {
          throw new HttpError(400, 'bad_request', `emoji must be one of ${REACTIONS.join(', ')}`);
        }
        const date = dateParam(request);
        const { team, role } = await teamAccess(request);
        await requireTeammateOrOwner(team, role, request.userId!);
        await requireCheckin(team.teamId, date, request.params.userId);
        const profile = await requireProfile(request.userId!);
        const on = method === 'PUT';
        await setReaction(
          team.teamId,
          date,
          request.params.userId,
          request.params.emoji,
          request.userId!,
          profile.name,
          on,
        );
        return { status: 200, body: { reacted: on } };
      },
    }),
  ),
  {
    method: 'GET',
    pattern: '/teams/:teamId/blockers',
    auth: true,
    handler: async (request) => {
      const { team } = await teamAccess(request);
      return { status: 200, body: { blockers: await getOpenBlockers(team.teamId) } };
    },
  },
  {
    method: 'POST',
    pattern: '/teams/:teamId/blockers/:date/:userId/resolve',
    auth: true,
    handler: async (request) => {
      const date = dateParam(request);
      const { team, role } = await teamAccess(request);
      await requireTeammateOrOwner(team, role, request.userId!);
      await resolveBlocker(team.teamId, date, request.params.userId, request.userId!);
      return { status: 200, body: { resolved: true } };
    },
  },
  {
    method: 'GET',
    pattern: '/me/checkins',
    auth: true,
    handler: async (request) => ({
      status: 200,
      body: await getHistory(request.userId!, request.query.cursor),
    }),
  },
];
