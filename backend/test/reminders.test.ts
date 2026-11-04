import { CloudWatchLogsClient, FilterLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
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

const SIMULATOR = 'success@simulator.amazonses.com';
const outputs = loadOutputs();
const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({ region: outputs.Region }));
const lambda = new LambdaClient({ region: outputs.Region });
const logs = new CloudWatchLogsClient({ region: outputs.Region });
const [dave, erin, frank] = await Promise.all(
  ['dave', 'erin', 'frank'].map((label) => createTestUser(`remind-${label}`)),
);
const partitions = [dave, erin, frank].map((user) => `USER#${user.userId}`);
const startedAt = Date.now();

async function invokeScheduler(scheduledTime: string) {
  const response = await lambda.send(
    new InvokeCommand({
      FunctionName: outputs.ReminderSchedulerName,
      Payload: Buffer.from(JSON.stringify({ scheduledTime })),
    }),
  );
  return JSON.parse(Buffer.from(response.Payload!).toString('utf8'));
}

try {
  for (const [user, name, timezone] of [
    [dave, 'Dave', 'UTC'],
    [erin, 'Erin', 'UTC'],
    [frank, 'Frank', 'America/New_York'],
  ] as const) {
    await call('PUT', '/me', { token: user.token, body: { name, timezone } });
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
    await call('POST', '/workspaces', { token: dave.token, body: { name: 'Reminders' } })
  ).body;
  partitions.push(`WS#${workspace.workspaceId}`, `INVITE#${workspace.inviteCode}`);
  const { team } = (
    await call('POST', `/workspaces/${workspace.workspaceId}/teams`, {
      token: dave.token,
      body: { name: 'Remind' },
    })
  ).body;
  partitions.push(`TEAM#${team.teamId}`);
  for (const user of [erin, frank]) {
    await call('POST', `/invites/${workspace.inviteCode}/join`, { token: user.token });
    await call('POST', `/teams/${team.teamId}/join`, { token: user.token });
  }
  await call('PUT', `/teams/${team.teamId}/config`, {
    token: dave.token,
    body: { questions: team.questions, workdays: [0, 1, 2, 3, 4, 5, 6], reminderTime: '03:15' },
  });
  const posted = await call('POST', `/teams/${team.teamId}/checkins`, {
    token: erin.token,
    body: { answers: ['done', 'next', ''] },
  });
  check('erin checked in', posted.status === 201, posted.body);

  const frankKey = { PK: `TEAM#${team.teamId}`, SK: `MEMBER#${frank.userId}` };
  await documentClient.send(
    new UpdateCommand({
      TableName: outputs.TableName,
      Key: frankKey,
      UpdateExpression: 'SET GSI3PK = :slot',
      ExpressionAttributeValues: { ':slot': 'REMIND#03:15' },
    }),
  );

  const today = new Date().toISOString().slice(0, 10);
  let result: any = null;
  const ready = await eventually(async () => {
    result = await invokeScheduler(`${today}T03:15:00Z`);
    return result.found >= 3;
  });
  check(
    'scheduler finds the slot and queues due members',
    ready && result.slot === 'REMIND#03:15' && result.queued >= 2 && result.skipped.checked_in >= 1,
    result,
  );
  check('scheduler moves a stale slot', result.movedSlots >= 1, result);
  const frankItem = (
    await documentClient.send(
      new GetCommand({ TableName: outputs.TableName, Key: frankKey, ConsistentRead: true }),
    )
  ).Item;
  check(
    'stale slot corrected',
    frankItem?.GSI3PK === reminderSlot('America/New_York', '03:15') &&
      frankItem.GSI3PK !== 'REMIND#03:15',
    frankItem?.GSI3PK,
  );

  let sentLines: string[] = [];
  const delivered = await eventually(async () => {
    const { events = [] } = await logs.send(
      new FilterLogEventsCommand({
        logGroupName: outputs.ReminderSenderLogGroup,
        startTime: startedAt,
        filterPattern: `"sent reminder team=${team.teamId}"`,
      }),
    );
    sentLines = events.map((event) => event.message ?? '');
    return sentLines.length >= 2;
  }, 40);
  check(
    'sender delivered both reminders through SES',
    delivered && sentLines.length === 2,
    sentLines,
  );

  const failures = await logs.send(
    new FilterLogEventsCommand({
      logGroupName: outputs.ReminderSenderLogGroup,
      startTime: startedAt,
      filterPattern: `"reminder failed team=${team.teamId}"`,
    }),
  );
  check('no send failures', (failures.events ?? []).length === 0, failures.events);

  result = await invokeScheduler(`${today}T03:30:00Z`);
  check('other slots untouched', result.slot === 'REMIND#03:30', result);
} finally {
  await Promise.all([dave, erin, frank].map((user) => user.remove()));
  await deletePartitions(outputs.Region, outputs.TableName, partitions);
}

finish();
