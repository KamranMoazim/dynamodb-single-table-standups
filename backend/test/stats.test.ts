import { CloudWatchLogsClient, FilterLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { addDays } from '../src/lib/time.js';
import {
  call,
  check,
  createTestUser,
  deletePartitions,
  eventually,
  finish,
  loadOutputs,
} from './helpers.js';

const SIMULATOR = 'success@simulator.amazonses.com';
const outputs = loadOutputs();
const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({ region: outputs.Region }));
const lambda = new LambdaClient({ region: outputs.Region });
const logs = new CloudWatchLogsClient({ region: outputs.Region });
const [gina, hal, ivy] = await Promise.all(
  ['gina', 'hal', 'ivy'].map((label) => createTestUser(`stats-${label}`)),
);
const partitions = [gina, hal, ivy].map((user) => `USER#${user.userId}`);
const startedAt = Date.now();
const today = new Date().toISOString().slice(0, 10);

const statsOf = async (userId: string, teamId: string) =>
  (
    await documentClient.send(
      new GetCommand({
        TableName: outputs.TableName,
        Key: { PK: `USER#${userId}`, SK: `STATS#${teamId}` },
        ConsistentRead: true,
      }),
    )
  ).Item;

async function invokeDigest(payload: unknown) {
  const response = await lambda.send(
    new InvokeCommand({
      FunctionName: outputs.DigestFunctionName,
      Payload: Buffer.from(JSON.stringify(payload)),
    }),
  );
  return JSON.parse(Buffer.from(response.Payload!).toString('utf8'));
}

try {
  for (const [user, name] of [
    [gina, 'Gina'],
    [hal, 'Hal'],
    [ivy, 'Ivy'],
  ] as const) {
    await call('PUT', '/me', { token: user.token, body: { name, timezone: 'UTC' } });
    await documentClient.send(
      new UpdateCommand({
        TableName: outputs.TableName,
        Key: { PK: `USER#${user.userId}`, SK: 'PROFILE' },
        UpdateExpression: 'SET email = :email',
        ExpressionAttributeValues: { ':email': SIMULATOR },
      }),
    );
  }
  const { workspace } = (
    await call('POST', '/workspaces', { token: gina.token, body: { name: 'Stats' } })
  ).body;
  partitions.push(`WS#${workspace.workspaceId}`, `INVITE#${workspace.inviteCode}`);
  const createTeam = async (name: string) =>
    (
      await call('POST', `/workspaces/${workspace.workspaceId}/teams`, {
        token: gina.token,
        body: { name },
      })
    ).body.team;
  const team = await createTeam('Streaks');
  const quietTeam = await createTeam('Quiet');
  partitions.push(`TEAM#${team.teamId}`, `TEAM#${quietTeam.teamId}`);
  for (const user of [hal, ivy]) {
    await call('POST', `/invites/${workspace.inviteCode}/join`, { token: user.token });
    await call('POST', `/teams/${team.teamId}/join`, { token: user.token });
  }
  await call('PUT', `/teams/${team.teamId}/config`, {
    token: gina.token,
    body: { questions: team.questions, workdays: [0, 1, 2, 3, 4, 5, 6], reminderTime: '09:00' },
  });

  const indexed = await eventually(async () => {
    const { Items = [] } = await documentClient.send(
      new QueryCommand({
        TableName: outputs.TableName,
        IndexName: 'GSI3',
        KeyConditionExpression: 'GSI3PK = :pk AND GSI3SK = :sk',
        ExpressionAttributeValues: { ':pk': 'DIGEST', ':sk': `TEAM#${team.teamId}` },
      }),
    );
    return Items.length === 1;
  });
  check('new team listed in the digest index', indexed);

  for (const daysAgo of [2, 1]) {
    const date = addDays(today, -daysAgo);
    await documentClient.send(
      new PutCommand({
        TableName: outputs.TableName,
        Item: {
          PK: `TEAM#${team.teamId}`,
          SK: `DAY#${date}#USER#${gina.userId}`,
          teamId: team.teamId,
          userId: gina.userId,
          date,
          authorName: 'Gina',
          answers: ['earlier', 'work', ''],
          createdAt: `${date}T09:00:00.000Z`,
          GSI1PK: `USER#${gina.userId}`,
          GSI1SK: `DAY#${date}#TEAM#${team.teamId}`,
        },
      }),
    );
    const total = 3 - daysAgo;
    check(
      `stream counts check-in from ${daysAgo} day(s) ago`,
      await eventually(async () => (await statsOf(gina.userId, team.teamId))?.total === total, 30),
    );
  }

  let response = await call('POST', `/teams/${team.teamId}/checkins`, {
    token: gina.token,
    body: { answers: ['a', 'b', ''] },
  });
  check('gina posts today', response.status === 201, response.body);
  response = await call('POST', `/teams/${team.teamId}/checkins`, {
    token: hal.token,
    body: { answers: ['x', 'y', ''], blocker: 'Need access' },
  });
  check('hal posts today with blocker', response.status === 201, response.body);

  let ginaStats: any = null;
  await eventually(async () => {
    ginaStats = await statsOf(gina.userId, team.teamId);
    return ginaStats?.total === 3;
  }, 30);
  check(
    'AP12 streak over consecutive workdays',
    ginaStats?.total === 3 &&
      ginaStats.currentStreak === 3 &&
      ginaStats.longestStreak === 3 &&
      ginaStats.lastDate === today,
    ginaStats,
  );
  check(
    'hal stats',
    await eventually(async () => (await statsOf(hal.userId, team.teamId))?.currentStreak === 1, 30),
  );

  await call('POST', `/teams/${team.teamId}/checkins/${today}/${gina.userId}/comments`, {
    token: hal.token,
    body: { text: 'nice' },
  });
  await call('PUT', `/teams/${team.teamId}/checkins/${today}/${gina.userId}/reactions/tada`, {
    token: hal.token,
  });
  await call('PUT', `/teams/${team.teamId}/checkins/today`, {
    token: gina.token,
    body: { answers: ['a', 'b', 'edited'] },
  });
  await new Promise((resolve) => setTimeout(resolve, 5000));
  ginaStats = await statsOf(gina.userId, team.teamId);
  check(
    'comments, reactions and edits do not count',
    ginaStats?.total === 3 && ginaStats.currentStreak === 3,
    ginaStats,
  );

  response = await call('GET', `/teams/${team.teamId}`, { token: ivy.token });
  const streaks = Object.fromEntries(
    response.body.members.map((member: any) => [member.name, `${member.streak}/${member.total}`]),
  );
  check(
    'team view shows streaks',
    streaks.Gina === '3/3' && streaks.Hal === '1/1' && streaks.Ivy === '0/0',
    streaks,
  );

  const tomorrow = addDays(today, 1);
  let result = await invokeDigest({
    scheduledTime: `${tomorrow}T08:00:00Z`,
    teamIds: [team.teamId],
  });
  check(
    'digest queues one email per member',
    result.weekEnd === today && result.weekStart === addDays(today, -6) && result.queued === 3,
    result,
  );
  result = await invokeDigest({
    scheduledTime: `${tomorrow}T08:00:00Z`,
    teamIds: [quietTeam.teamId],
  });
  check('quiet team gets no digest', result.skippedQuiet === 1 && result.queued === 0, result);

  let sent: string[] = [];
  const delivered = await eventually(async () => {
    const { events = [] } = await logs.send(
      new FilterLogEventsCommand({
        logGroupName: outputs.ReminderSenderLogGroup,
        startTime: startedAt,
        filterPattern: `"sent digest team=${team.teamId}"`,
      }),
    );
    sent = events.map((event) => event.message ?? '');
    return sent.length >= 3;
  }, 40);
  check('digests delivered through SES', delivered && sent.length === 3, sent);
} finally {
  await Promise.all([gina, hal, ivy].map((user) => user.remove()));
  await deletePartitions(outputs.Region, outputs.TableName, partitions);
}

finish();
