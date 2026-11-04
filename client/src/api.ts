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
};
