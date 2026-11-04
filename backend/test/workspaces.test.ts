import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { reminderSlot } from '../src/lib/time.js';
import {
  call,
  check,
  createTestUser,
  deletePartitions,
  eventually,
  finish,
  loadOutputs,
} from './helpers.js';

const outputs = loadOutputs();
const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({ region: outputs.Region }));
const alice = await createTestUser('alice');
const bob = await createTestUser('bob');
const eve = await createTestUser('eve');
const partitions = [alice, bob, eve].map((user) => `USER#${user.userId}`);

const memberItem = async (teamId: string, userId: string) =>
  (
    await documentClient.send(
      new GetCommand({
        TableName: outputs.TableName,
        Key: { PK: `TEAM#${teamId}`, SK: `MEMBER#${userId}` },
        ConsistentRead: true,
      }),
    )
  ).Item;

try {
  let response = await call('GET', '/me', { token: alice.token });
  check(
    'AP1 new user has no profile',
    response.status === 200 &&
      response.body.profile === null &&
      response.body.workspaces.length === 0,
    response.body,
  );

  response = await call('POST', '/workspaces', { token: alice.token, body: { name: 'Acme' } });
  check(
    'workspace needs profile',
    response.status === 409 && response.body.error === 'profile_required',
    response.body,
  );

  response = await call('PUT', '/me', {
    token: alice.token,
    body: { name: 'Alice', timezone: 'Mars/Base' },
  });
  check('invalid timezone', response.status === 400, response.body);

  for (const [user, name, timezone] of [
    [alice, 'Alice', 'America/New_York'],
    [bob, 'Bob', 'Asia/Karachi'],
    [eve, 'Eve', 'UTC'],
  ] as const) {
    response = await call('PUT', '/me', { token: user.token, body: { name, timezone } });
    check(`profile saved for ${name}`, response.status === 200, response.body);
  }

  response = await call('POST', '/workspaces', { token: alice.token, body: { name: ' ' } });
  check('workspace name required', response.status === 400, response.body);

  response = await call('POST', '/workspaces', { token: alice.token, body: { name: 'Acme' } });
  check(
    'create workspace',
    response.status === 201 && /^[A-Z2-9]{8}$/.test(response.body.workspace.inviteCode),
    response.body,
  );
  const { workspaceId, inviteCode } = response.body.workspace;
  partitions.push(`WS#${workspaceId}`, `INVITE#${inviteCode}`);

  response = await call('GET', '/me', { token: alice.token });
  check(
    'AP1 lists workspace as owner',
    response.body.profile?.name === 'Alice' &&
      response.body.workspaces.some(
        (workspace: any) => workspace.workspaceId === workspaceId && workspace.role === 'owner',
      ),
    response.body,
  );

  response = await call('GET', `/workspaces/${workspaceId}`, { token: bob.token });
  check('AP2 hidden from non-members', response.status === 404, response.body);

  response = await call('POST', '/invites/NOPE2345/join', { token: bob.token });
  check(
    'AP3 unknown invite',
    response.status === 404 && response.body.error === 'invite_not_found',
    response.body,
  );

  response = await call('POST', `/invites/${inviteCode.toLowerCase()}/join`, { token: bob.token });
  check(
    'AP3 join by invite, any case',
    response.status === 200 && response.body.workspace.workspaceId === workspaceId,
    response.body,
  );

  response = await call('POST', `/invites/${inviteCode}/join`, { token: bob.token });
  check(
    'AP3 join twice',
    response.status === 409 && response.body.error === 'already_member',
    response.body,
  );

  response = await call('GET', `/workspaces/${workspaceId}`, { token: bob.token });
  const roles = Object.fromEntries(
    (response.body.members ?? []).map((member: any) => [member.name, member.role]),
  );
  check(
    'AP2 members with roles',
    response.status === 200 && roles.Alice === 'owner' && roles.Bob === 'member',
    response.body,
  );

  response = await call('POST', `/workspaces/${workspaceId}/teams`, {
    token: bob.token,
    body: { name: 'Platform' },
  });
  check('member cannot create team', response.status === 403, response.body);

  response = await call('POST', `/workspaces/${workspaceId}/teams`, {
    token: alice.token,
    body: { name: 'Platform' },
  });
  const team = response.body.team;
  check(
    'create team with defaults',
    response.status === 201 &&
      team.questions.length === 3 &&
      JSON.stringify(team.workdays) === JSON.stringify([1, 2, 3, 4, 5]) &&
      team.reminderTime === '09:00',
    response.body,
  );
  partitions.push(`TEAM#${team.teamId}`);

  response = await call('GET', `/workspaces/${workspaceId}`, { token: alice.token });
  check(
    'AP2 lists team',
    response.body.teams.some((item: any) => item.teamId === team.teamId),
    response.body,
  );

  response = await call('GET', `/teams/${team.teamId}`, { token: eve.token });
  check('AP4 hidden from outsiders', response.status === 404, response.body);

  response = await call('GET', `/teams/${team.teamId}`, { token: bob.token });
  check(
    'AP4 config and members',
    response.status === 200 &&
      response.body.role === 'member' &&
      response.body.members.length === 1 &&
      response.body.members[0].name === 'Alice' &&
      response.body.team.reminderTime === '09:00',
    response.body,
  );

  response = await call('POST', `/teams/${team.teamId}/join`, { token: eve.token });
  check('outsider cannot join team', response.status === 404, response.body);

  response = await call('POST', `/teams/${team.teamId}/join`, { token: bob.token });
  check('join team', response.status === 200, response.body);

  response = await call('POST', `/teams/${team.teamId}/join`, { token: bob.token });
  check('join team twice', response.status === 409, response.body);

  response = await call('GET', '/me', { token: bob.token });
  check(
    'AP1 lists team',
    response.body.teams.some((item: any) => item.teamId === team.teamId),
    response.body,
  );

  const bobSlot = reminderSlot('Asia/Karachi', '09:00');
  const indexed = await eventually(async () => {
    const { Items = [] } = await documentClient.send(
      new QueryCommand({
        TableName: outputs.TableName,
        IndexName: 'GSI3',
        KeyConditionExpression: 'GSI3PK = :slot AND GSI3SK = :sk',
        ExpressionAttributeValues: {
          ':slot': bobSlot,
          ':sk': `TEAM#${team.teamId}#USER#${bob.userId}`,
        },
      }),
    );
    return Items.length === 1;
  });
  check(`GSI3 has member in ${bobSlot}`, indexed && bobSlot === 'REMIND#04:00');

  const config = {
    questions: ['Done?', 'Next?', 'Stuck?'],
    workdays: [1, 2, 3, 4],
    reminderTime: '10:30',
  };
  response = await call('PUT', `/teams/${team.teamId}/config`, { token: bob.token, body: config });
  check('member cannot change config', response.status === 403, response.body);

  response = await call('PUT', `/teams/${team.teamId}/config`, {
    token: alice.token,
    body: { ...config, reminderTime: '10:10' },
  });
  check('config validated', response.status === 400, response.body);

  response = await call('PUT', `/teams/${team.teamId}/config`, {
    token: alice.token,
    body: config,
  });
  check(
    'owner changes config',
    response.status === 200 && response.body.team.reminderTime === '10:30',
    response.body,
  );
  check(
    'config change moves reminder slots',
    (await memberItem(team.teamId, bob.userId))?.GSI3PK === reminderSlot('Asia/Karachi', '10:30') &&
      (await memberItem(team.teamId, alice.userId))?.GSI3PK ===
        reminderSlot('America/New_York', '10:30'),
  );

  response = await call('PUT', '/me', {
    token: bob.token,
    body: { name: 'Bobby', timezone: 'Europe/London' },
  });
  const bobMember = await memberItem(team.teamId, bob.userId);
  check(
    'profile change updates team member copy',
    response.status === 200 &&
      bobMember?.name === 'Bobby' &&
      bobMember?.timezone === 'Europe/London' &&
      bobMember?.GSI3PK === reminderSlot('Europe/London', '10:30'),
    bobMember,
  );
  response = await call('GET', `/workspaces/${workspaceId}`, { token: alice.token });
  check(
    'profile change updates workspace member copy',
    response.body.members.some((member: any) => member.name === 'Bobby'),
    response.body,
  );

  response = await call('DELETE', `/teams/${team.teamId}/members/${alice.userId}`, {
    token: bob.token,
  });
  check('member cannot remove others', response.status === 403, response.body);

  response = await call('DELETE', `/teams/${team.teamId}/members/${bob.userId}`, {
    token: bob.token,
  });
  check('leave team', response.status === 200, response.body);

  response = await call('DELETE', `/teams/${team.teamId}/members/${bob.userId}`, {
    token: alice.token,
  });
  check('remove non-member', response.status === 404, response.body);

  response = await call('GET', '/me', { token: bob.token });
  check(
    'AP1 team gone after leaving',
    !response.body.teams.some((item: any) => item.teamId === team.teamId),
    response.body,
  );
} finally {
  await Promise.all([alice, bob, eve].map((user) => user.remove()));
  await deletePartitions(outputs.Region, outputs.TableName, partitions);
}

finish();
