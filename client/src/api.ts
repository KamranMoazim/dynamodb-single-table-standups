import { getIdToken } from './auth';
import { loadConfig } from './config';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function apiCall<T>(method: string, path: string, body?: unknown): Promise<T> {
  const { apiUrl } = await loadConfig();
  const token = await getIdToken();
  const response = await fetch(apiUrl + path, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new ApiError(
      response.status,
      payload.error ?? 'error',
      payload.message ?? response.statusText,
    );
  }
  return payload as T;
}

export type Role = 'owner' | 'member';

export interface Profile {
  name: string;
  timezone: string;
}

export interface Me {
  userId: string;
  email: string;
  profile: Profile | null;
  workspaces: { workspaceId: string; name: string; role: Role }[];
  teams: { teamId: string; workspaceId: string; name: string }[];
}

export interface Workspace {
  workspaceId: string;
  name: string;
  inviteCode: string;
  ownerId: string;
  createdAt: string;
}

export interface WorkspaceView {
  workspace: Workspace;
  members: { userId: string; name: string; role: Role; joinedAt: string }[];
  teams: { teamId: string; name: string }[];
}

export interface TeamConfig {
  questions: string[];
  workdays: number[];
  reminderTime: string;
}

export interface Team extends TeamConfig {
  teamId: string;
  workspaceId: string;
  name: string;
  createdAt: string;
}

export interface TeamView {
  team: Team;
  members: { userId: string; name: string; timezone: string; joinedAt: string }[];
  role: Role;
}

export interface CheckinInput {
  answers: string[];
  blocker: string | null;
}

export interface Checkin extends CheckinInput {
  teamId: string;
  userId: string;
  date: string;
  authorName: string;
  createdAt: string;
  updatedAt: string;
  blockerResolvedBy?: string;
  blockerResolvedAt?: string;
}

export interface Comment {
  commentId: string;
  byUserId: string;
  byName: string;
  text: string;
  createdAt: string;
}

export interface FeedEntry extends Checkin {
  comments: Comment[];
  reactions: Record<string, { userId: string; name: string }[]>;
}

export interface Feed {
  date: string;
  isWorkday: boolean;
  checkins: FeedEntry[];
  missing: { userId: string; name: string }[];
}

export interface Blocker {
  userId: string;
  date: string;
  authorName: string;
  blocker: string;
}

export type HistoryEntry = Pick<
  Checkin,
  'teamId' | 'userId' | 'date' | 'authorName' | 'answers' | 'blocker'
>;

const checkinPath = (teamId: string, date: string, userId: string) =>
  `/teams/${teamId}/checkins/${date}/${userId}`;

export const api = {
  me: () => apiCall<Me>('GET', '/me'),
  saveProfile: (profile: Profile) => apiCall<{ profile: Profile }>('PUT', '/me', profile),
  createWorkspace: (name: string) =>
    apiCall<{ workspace: Workspace }>('POST', '/workspaces', { name }),
  workspace: (workspaceId: string) => apiCall<WorkspaceView>('GET', `/workspaces/${workspaceId}`),
  joinWorkspace: (code: string) =>
    apiCall<{ workspace: Workspace }>('POST', `/invites/${encodeURIComponent(code.trim())}/join`),
  createTeam: (workspaceId: string, name: string) =>
    apiCall<{ team: Team }>('POST', `/workspaces/${workspaceId}/teams`, { name }),
  team: (teamId: string) => apiCall<TeamView>('GET', `/teams/${teamId}`),
  saveTeamConfig: (teamId: string, config: TeamConfig) =>
    apiCall<{ team: Team }>('PUT', `/teams/${teamId}/config`, config),
  joinTeam: (teamId: string) => apiCall<{ joined: boolean }>('POST', `/teams/${teamId}/join`),
  removeTeamMember: (teamId: string, userId: string) =>
    apiCall<{ removed: boolean }>('DELETE', `/teams/${teamId}/members/${userId}`),
  todayCheckin: (teamId: string) =>
    apiCall<{ date: string; checkin: Checkin | null }>('GET', `/teams/${teamId}/checkins/today`),
  submitCheckin: (teamId: string, input: CheckinInput) =>
    apiCall<{ checkin: Checkin }>('POST', `/teams/${teamId}/checkins`, input),
  editCheckin: (teamId: string, input: CheckinInput) =>
    apiCall<{ checkin: Checkin }>('PUT', `/teams/${teamId}/checkins/today`, input),
  feed: (teamId: string, date?: string) =>
    apiCall<Feed>('GET', `/teams/${teamId}/feed${date ? `?date=${date}` : ''}`),
  comment: (teamId: string, date: string, userId: string, text: string) =>
    apiCall<{ comment: Comment }>('POST', `${checkinPath(teamId, date, userId)}/comments`, {
      text,
    }),
  react: (teamId: string, date: string, userId: string, emoji: string, on: boolean) =>
    apiCall<{ reacted: boolean }>(
      on ? 'PUT' : 'DELETE',
      `${checkinPath(teamId, date, userId)}/reactions/${emoji}`,
    ),
  blockers: (teamId: string) =>
    apiCall<{ blockers: Blocker[] }>('GET', `/teams/${teamId}/blockers`),
  resolveBlocker: (teamId: string, date: string, userId: string) =>
    apiCall<{ resolved: boolean }>('POST', `/teams/${teamId}/blockers/${date}/${userId}/resolve`),
  history: (cursor?: string | null) =>
    apiCall<{ checkins: HistoryEntry[]; nextCursor: string | null }>(
      'GET',
      `/me/checkins${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
    ),
};
