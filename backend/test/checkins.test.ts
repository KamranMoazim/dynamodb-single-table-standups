import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { BatchWriteCommand, DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { localDate } from '../src/lib/time.js';
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
const [alice, bob, carol, eve] = await Promise.all(
  ['alice', 'bob', 'carol', 'eve'].map((label) => createTestUser(`checkin-${label}`)),
);
const partitions = [alice, bob, carol, eve].map((user) => `USER#${user.userId}`);
const today = localDate('UTC');

const checkinItem = async (teamId: string, userId: string) =>
  (
    await documentClient.send(
      new GetCommand({
        TableName: outputs.TableName,
        Key: { PK: `TEAM#${teamId}`, SK: `DAY#${today}#USER#${userId}` },
        ConsistentRead: true,
      }),
    )
  ).Item;

try {
  for (const [user, name] of [
    [alice, 'Alice'],
    [bob, 'Bob'],
    [carol, 'Carol'],
    [eve, 'Eve'],
  ] as const) {
    await call('PUT', '/me', { token: user.token, body: { name, timezone: 'UTC' } });
  }
  const { workspace } = (
    await call('POST', '/workspaces', { token: alice.token, body: { name: 'Checkins' } })
  ).body;
  partitions.push(`WS#${workspace.workspaceId}`, `INVITE#${workspace.inviteCode}`);
  const { team } = (
    await call('POST', `/workspaces/${workspace.workspaceId}/teams`, {
      token: alice.token,
      body: { name: 'Core' },
    })
  ).body;
  partitions.push(`TEAM#${team.teamId}`);
  await call('POST', `/invites/${workspace.inviteCode}/join`, { token: bob.token });
  await call('POST', `/invites/${workspace.inviteCode}/join`, { token: carol.token });
  await call('POST', `/teams/${team.teamId}/join`, { token: bob.token });
  const base = `/teams/${team.teamId}`;

  let response = await call('GET', `${base}/checkins/today`, { token: bob.token });
  check(
    'no check-in yet',
    response.status === 200 && response.body.checkin === null && response.body.date === today,
    response.body,
  );

  const bobCheckin = {
    answers: ['Wrote tests', 'Ship feed', 'Waiting on design'],
    blocker: 'Need design review',
  };
  response = await call('POST', `${base}/checkins`, { token: carol.token, body: bobCheckin });
  check(
    'non team member cannot check in',
    response.status === 403 && response.body.error === 'not_team_member',
    response.body,
  );

  response = await call('POST', `${base}/checkins`, { token: eve.token, body: bobCheckin });
  check('outsider cannot see team', response.status === 404, response.body);

  response = await call('POST', `${base}/checkins`, {
    token: bob.token,
    body: { answers: ['a', 'b'] },
  });
  check('answers validated', response.status === 400, response.body);

  response = await call('POST', `${base}/checkins`, { token: bob.token, body: bobCheckin });
  check(
    'AP6 submit with blocker',
    response.status === 201 && response.body.checkin.date === today,
    response.body,
  );

  response = await call('POST', `${base}/checkins`, { token: bob.token, body: bobCheckin });
  check(
    'one per day',
    response.status === 409 && response.body.error === 'already_submitted',
    response.body,
  );

  response = await call('GET', `${base}/checkins/today`, { token: bob.token });
  check(
    'read own check-in right after submit',
    response.body.checkin?.blocker === 'Need design review',
    response.body,
  );

  let item = await checkinItem(team.teamId, bob.userId);
  check(
    'check-in indexed in GSI1 and GSI2',
    item?.GSI1PK === `USER#${bob.userId}` &&
      item?.GSI1SK === `DAY#${today}#TEAM#${team.teamId}` &&
      item?.GSI2PK === `BLOCKERS#${team.teamId}`,
    item,
  );

  response = await call('GET', `${base}/feed`, { token: alice.token });
  check(
    'AP10 missing lists only team members without a check-in',
    response.status === 200 &&
      response.body.missing.length === 1 &&
      response.body.missing[0].name === 'Alice' &&
      response.body.checkins.length === 1,
    response.body,
  );

  response = await call('POST', `${base}/checkins`, {
    token: alice.token,
    body: { answers: ['Planned', 'Review', ''] },
  });
  check(
    'submit without blocker',
    response.status === 201 && response.body.checkin.blocker === null,
    response.body,
  );
  item = await checkinItem(team.teamId, alice.userId);
  check(
    'no blocker, not in GSI2',
    item !== undefined && item.GSI2PK === undefined && item.blocker === undefined,
    item,
  );

  const bobPath = `${base}/checkins/${today}/${bob.userId}`;
  const alicePath = `${base}/checkins/${today}/${alice.userId}`;
  response = await call('POST', `${bobPath}/comments`, {
    token: carol.token,
    body: { text: 'hi' },
  });
  check('non team member cannot comment', response.status === 403, response.body);

  response = await call('POST', `${bobPath}/comments`, {
    token: alice.token,
    body: { text: 'I can review at 2pm' },
  });
  check(
    'AP7 comment',
    response.status === 201 && response.body.comment.byName === 'Alice',
    response.body,
  );
  await call('POST', `${bobPath}/comments`, { token: bob.token, body: { text: 'Thanks!' } });

  response = await call('POST', `${bobPath}/comments`, {
    token: alice.token,
    body: { text: 'x'.repeat(501) },
  });
  check('comment length capped', response.status === 400, response.body);

  response = await call('POST', `${base}/checkins/${today}/${carol.userId}/comments`, {
    token: alice.token,
    body: { text: 'hi' },
  });
  check('comment on missing check-in', response.status === 404, response.body);

  response = await call('POST', `${base}/checkins/2026-02-30/${bob.userId}/comments`, {
    token: alice.token,
    body: { text: 'hi' },
  });
  check('invalid date param', response.status === 400, response.body);

  response = await call('PUT', `${alicePath}/reactions/skull`, { token: bob.token });
  check('unknown reaction rejected', response.status === 400, response.body);

  for (const emoji of ['thumbsup', 'tada']) {
    response = await call('PUT', `${alicePath}/reactions/${emoji}`, { token: bob.token });
  }
  response = await call('PUT', `${bobPath}/reactions/heart`, { token: alice.token });
  check('AP7 react', response.status === 200, response.body);
  response = await call('PUT', `${bobPath}/reactions/heart`, { token: alice.token });
  check('react twice is idempotent', response.status === 200, response.body);
  response = await call('DELETE', `${alicePath}/reactions/tada`, { token: bob.token });
  check(
    'remove reaction',
    response.status === 200 && response.body.reacted === false,
    response.body,
  );

  let feed: any = null;
  const feedReady = await eventually(async () => {
    feed = (await call('GET', `${base}/feed?date=${today}`, { token: carol.token })).body;
    const bobEntry = feed.checkins?.find((entry: any) => entry.userId === bob.userId);
    const aliceEntry = feed.checkins?.find((entry: any) => entry.userId === alice.userId);
    return (
      bobEntry?.comments.length === 2 &&
      aliceEntry?.reactions.thumbsup?.length === 1 &&
      !aliceEntry.reactions.tada
    );
  });
  const bobEntry = feed.checkins.find((entry: any) => entry.userId === bob.userId);
  check(
    'AP5 feed: check-ins with comments and reactions in one query',
    feedReady &&
      feed.missing.length === 0 &&
      bobEntry.comments.map((comment: any) => comment.text).join('|') ===
        'I can review at 2pm|Thanks!' &&
      bobEntry.reactions.heart.length === 1 &&
      bobEntry.reactions.heart[0].name === 'Alice',
    feed,
  );

  response = await call('GET', `${base}/feed?date=2026-13-01`, { token: alice.token });
  check('feed date validated', response.status === 400, response.body);

  response = await call('GET', `${base}/feed?date=2020-01-01`, { token: alice.token });
  check(
    'empty day feed',
    response.status === 200 &&
      response.body.checkins.length === 0 &&
      response.body.missing.length === 2,
    response.body,
  );

  const openBlockers = async () =>
    (await call('GET', `${base}/blockers`, { token: alice.token })).body.blockers ?? [];
  check(
    'AP9 open blockers',
    await eventually(async () =>
      (await openBlockers()).some((blocker: any) => blocker.blocker === 'Need design review'),
    ),
  );

  response = await call('POST', `${base}/blockers/${today}/${bob.userId}/resolve`, {
    token: carol.token,
  });
  check('non teammate cannot resolve', response.status === 403, response.body);

  response = await call('POST', `${base}/blockers/${today}/${alice.userId}/resolve`, {
    token: bob.token,
  });
  check('resolve without blocker', response.status === 409, response.body);

  response = await call('POST', `${base}/blockers/${today}/${bob.userId}/resolve`, {
    token: alice.token,
  });
  check('resolve blocker', response.status === 200, response.body);
  response = await call('POST', `${base}/blockers/${today}/${bob.userId}/resolve`, {
    token: alice.token,
  });
  check('resolve twice', response.status === 409, response.body);
  check(
    'resolved blocker leaves the index',
    await eventually(async () => (await openBlockers()).length === 0),
  );
  item = await checkinItem(team.teamId, bob.userId);
  check(
    'resolution recorded',
    item?.blockerResolvedBy === alice.userId && item?.blocker === 'Need design review',
    item,
  );

  response = await call('PUT', `${base}/checkins/today`, {
    token: bob.token,
    body: { ...bobCheckin, blocker: 'Now blocked on QA' },
  });
  check(
    'edit with new blocker',
    response.status === 200 && response.body.checkin.blocker === 'Now blocked on QA',
    response.body,
  );
  check(
    'edited blocker reopens',
    await eventually(async () =>
      (await openBlockers()).some((blocker: any) => blocker.blocker === 'Now blocked on QA'),
    ),
  );

  response = await call('PUT', `${base}/checkins/today`, {
    token: bob.token,
    body: { answers: bobCheckin.answers, blocker: null },
  });
  check(
    'edit clears blocker',
    response.status === 200 && response.body.checkin.blocker === null,
    response.body,
  );
  check(
    'cleared blocker leaves the index',
    await eventually(async () => (await openBlockers()).length === 0),
  );

  response = await call('PUT', `${base}/checkins/today`, { token: carol.token, body: bobCheckin });
  check('edit without a check-in', response.status === 404, response.body);

  const pastDays = Array.from({ length: 21 }, (_, index) => {
    const date = new Date(Date.UTC(2025, 0, 1 + index)).toISOString().slice(0, 10);
    return {
      PutRequest: {
        Item: {
          PK: `TEAM#${team.teamId}`,
          SK: `DAY#${date}#USER#${bob.userId}`,
          teamId: team.teamId,
          userId: bob.userId,
          date,
          authorName: 'Bob',
          answers: ['old', 'old', ''],
          GSI1PK: `USER#${bob.userId}`,
          GSI1SK: `DAY#${date}#TEAM#${team.teamId}`,
        },
      },
    };
  });
  for (let start = 0; start < pastDays.length; start += 25) {
    await documentClient.send(
      new BatchWriteCommand({
        RequestItems: { [outputs.TableName]: pastDays.slice(start, start + 25) },
      }),
    );
  }
  let firstPage: any = null;
  await eventually(async () => {
    firstPage = (await call('GET', '/me/checkins', { token: bob.token })).body;
    return firstPage.checkins?.length === 20;
  });
  check(
    'AP8 history newest first, paged',
    firstPage.checkins[0].date === today &&
      firstPage.checkins[1].date === '2025-01-21' &&
      firstPage.nextCursor !== null,
    firstPage.checkins?.slice(0, 2),
  );
  response = await call('GET', `/me/checkins?cursor=${firstPage.nextCursor}`, { token: bob.token });
  check(
    'AP8 second page',
    response.status === 200 &&
      response.body.checkins.length === 2 &&
      response.body.checkins[1].date === '2025-01-01' &&
      response.body.nextCursor === null,
    response.body,
  );
  response = await call('GET', `/me/checkins?cursor=${firstPage.nextCursor}`, {
    token: alice.token,
  });
  check('cursor bound to its user', response.status === 400, response.body);
  response = await call('GET', '/me/checkins?cursor=garbage', { token: bob.token });
  check('garbage cursor', response.status === 400, response.body);
} finally {
  await Promise.all([alice, bob, carol, eve].map((user) => user.remove()));
  await deletePartitions(outputs.Region, outputs.TableName, partitions);
}

finish();
