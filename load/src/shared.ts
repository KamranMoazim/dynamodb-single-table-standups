import {
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

export interface Outputs {
  Region: string;
  TableName: string;
  UserPoolId: string;
  UserPoolClientId: string;
  ApiUrl: string;
}

export interface SimUser {
  email: string;
  userId: string;
  name: string;
  timezone: string;
  password: string;
  refreshToken?: string;
}

export interface SimTeam {
  teamId: string;
  workspaceId: string;
  memberIds: string[];
}

export interface SimState {
  createdAt: string;
  users: SimUser[];
  workspaces: { workspaceId: string; inviteCode: string; ownerId: string }[];
  teams: SimTeam[];
}

const STATE_URL = new URL('../state.json', import.meta.url);

export function loadOutputs(): Outputs {
  const path = new URL('../../infra/cdk-outputs.json', import.meta.url);
  return JSON.parse(readFileSync(path, 'utf8')).StandupLogStack;
}

export function readState(): SimState | null {
  return existsSync(STATE_URL) ? (JSON.parse(readFileSync(STATE_URL, 'utf8')) as SimState) : null;
}

export function writeState(state: SimState): void {
  writeFileSync(STATE_URL, JSON.stringify(state, null, 2) + '\n');
}

export async function apiCall(
  outputs: Outputs,
  method: string,
  path: string,
  token: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const response = await fetch(outputs.ApiUrl + path, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let parsed: any = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: response.status, body: parsed };
}

export function cognitoClient(outputs: Outputs): CognitoIdentityProviderClient {
  return new CognitoIdentityProviderClient({ region: outputs.Region, maxAttempts: 8 });
}

export async function signIn(
  cognito: CognitoIdentityProviderClient,
  outputs: Outputs,
  user: SimUser,
): Promise<{ idToken: string; refreshToken?: string }> {
  const parameters: Record<string, string> = user.refreshToken
    ? { REFRESH_TOKEN: user.refreshToken }
    : { USERNAME: user.email, PASSWORD: user.password };
  const result = await cognito.send(
    new InitiateAuthCommand({
      ClientId: outputs.UserPoolClientId,
      AuthFlow: user.refreshToken ? 'REFRESH_TOKEN_AUTH' : 'USER_PASSWORD_AUTH',
      AuthParameters: parameters,
    }),
  );
  return {
    idToken: result.AuthenticationResult!.IdToken!,
    refreshToken: result.AuthenticationResult!.RefreshToken ?? user.refreshToken,
  };
}

export async function inBatches<T>(
  items: T[],
  concurrency: number,
  work: (item: T, index: number) => Promise<void>,
) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        await work(items[index], index);
      }
    }),
  );
}
