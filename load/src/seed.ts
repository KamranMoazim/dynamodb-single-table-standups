import {
  AdminCreateUserCommand,
  AdminSetUserPasswordCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { randomBytes } from 'node:crypto';
import {
  apiCall,
  cognitoClient,
  inBatches,
  loadOutputs,
  readState,
  signIn,
  writeState,
  type SimState,
  type SimUser,
} from './shared.js';

const WORKSPACES = 20;
const USERS_PER_WORKSPACE = 15;
const TIMEZONES = [
  'UTC',
  'America/New_York',
  'America/Los_Angeles',
  'Europe/Berlin',
  'Asia/Karachi',
  'Asia/Tokyo',
];
const REMINDER_TIMES = ['08:30', '09:00', '09:30', '10:00', '10:30'];

const outputs = loadOutputs();
const cognito = cognitoClient(outputs);
if (readState()) {
  console.error('load/state.json exists: run npm run cleanup first');
  process.exit(1);
}

const state: SimState = {
  createdAt: new Date().toISOString(),
  users: [],
  workspaces: [],
  teams: [],
};
const tokens = new Map<string, string>();
const pad = (value: number) => String(value).padStart(3, '0');

const blankUsers = Array.from({ length: WORKSPACES * USERS_PER_WORKSPACE }, (_, index) => ({
  email: `success+sim-${pad(index)}@simulator.amazonses.com`,
  name: `Sim ${pad(index)}`,
  timezone: TIMEZONES[index % TIMEZONES.length],
  password: `Sim-${randomBytes(12).toString('hex')}`,
}));

await inBatches(blankUsers, 8, async (blank, index) => {
  const created = await cognito.send(
    new AdminCreateUserCommand({
      UserPoolId: outputs.UserPoolId,
      Username: blank.email,
      MessageAction: 'SUPPRESS',
      UserAttributes: [
        { Name: 'email', Value: blank.email },
        { Name: 'email_verified', Value: 'true' },
      ],
    }),
  );
  await cognito.send(
    new AdminSetUserPasswordCommand({
      UserPoolId: outputs.UserPoolId,
      Username: blank.email,
      Password: blank.password,
      Permanent: true,
    }),
  );
  const user: SimUser = {
    ...blank,
    userId: created.User!.Attributes!.find((attribute) => attribute.Name === 'sub')!.Value!,
  };
  const session = await signIn(cognito, outputs, user);
  user.refreshToken = session.refreshToken;
  tokens.set(user.userId, session.idToken);
  const saved = await apiCall(outputs, 'PUT', '/me', session.idToken, {
    name: user.name,
    timezone: user.timezone,
  });
  if (saved.status !== 200) {
    throw new Error(`profile for ${user.name} failed: ${saved.status}`);
  }
  state.users[index] = user;
  if (state.users.filter(Boolean).length % 50 === 0) {
    writeState(state);
    console.log(`users: ${state.users.filter(Boolean).length}`);
  }
});
writeState(state);

async function expect(status: number, call: Promise<{ status: number; body: any }>, what: string) {
  const response = await call;
  if (response.status !== status) {
    throw new Error(`${what} returned ${response.status}: ${JSON.stringify(response.body)}`);
  }
  return response.body;
}

await inBatches(
  Array.from({ length: WORKSPACES }, (_, index) => index),
  4,
  async (workspaceIndex) => {
    const members = state.users.slice(
      workspaceIndex * USERS_PER_WORKSPACE,
      (workspaceIndex + 1) * USERS_PER_WORKSPACE,
    );
    const owner = members[0];
    const ownerToken = tokens.get(owner.userId)!;
    const { workspace } = await expect(
      201,
      apiCall(outputs, 'POST', '/workspaces', ownerToken, {
        name: `Sim Workspace ${workspaceIndex + 1}`,
      }),
      'create workspace',
    );
    state.workspaces.push({
      workspaceId: workspace.workspaceId,
      inviteCode: workspace.inviteCode,
      ownerId: owner.userId,
    });
    for (const member of members.slice(1)) {
      await expect(
        200,
        apiCall(
          outputs,
          'POST',
          `/invites/${workspace.inviteCode}/join`,
          tokens.get(member.userId)!,
        ),
        'join',
      );
    }
    const half = Math.ceil(members.length / 2);
    for (const [teamIndex, teamName] of ['Platform', 'Product'].entries()) {
      const { team } = await expect(
        201,
        apiCall(outputs, 'POST', `/workspaces/${workspace.workspaceId}/teams`, ownerToken, {
          name: `${teamName} ${workspaceIndex + 1}`,
        }),
        'create team',
      );
      await expect(
        200,
        apiCall(outputs, 'PUT', `/teams/${team.teamId}/config`, ownerToken, {
          questions: team.questions,
          workdays: [1, 2, 3, 4, 5],
          reminderTime: REMINDER_TIMES[(workspaceIndex + teamIndex) % REMINDER_TIMES.length],
        }),
        'config',
      );
      const primary = teamIndex === 0 ? members.slice(1, half) : members.slice(half);
      const crossOver = (teamIndex === 0 ? members.slice(half) : members.slice(1, half)).filter(
        (_, index) => index % 3 === 0,
      );
      const joiners = [...primary, ...crossOver];
      for (const member of joiners) {
        await expect(
          200,
          apiCall(outputs, 'POST', `/teams/${team.teamId}/join`, tokens.get(member.userId)!),
          'join team',
        );
      }
      state.teams.push({
        teamId: team.teamId,
        workspaceId: workspace.workspaceId,
        memberIds: [owner.userId, ...joiners.map((member) => member.userId)],
      });
    }
    writeState(state);
    console.log(`workspace ${workspaceIndex + 1} ready`);
  },
);

const sizes = state.teams.map((team) => team.memberIds.length);
console.log(
  `seeded ${state.users.length} users, ${state.workspaces.length} workspaces, ${state.teams.length} teams ` +
    `(team size ${Math.min(...sizes)}-${Math.max(...sizes)}, average ${(sizes.reduce((sum, size) => sum + size, 0) / sizes.length).toFixed(1)})`,
);
