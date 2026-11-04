import { BatchGetCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { SQSClient, SendMessageBatchCommand } from '@aws-sdk/client-sqs';
import { META_SK, PROFILE_SK, checkinSk, memberSk, teamPk, userPk } from '../lib/keys.js';
import { TABLE_NAME, documentClient } from '../lib/table.js';
import { slotAt } from '../lib/time.js';
import type { ReminderMessage } from '../email/templates.js';
import { planReminder } from './plan.js';

const sqs = new SQSClient({});
const QUEUE_URL = process.env.QUEUE_URL!;

type Key = { PK: string; SK: string };
const keyId = (key: Key) => `${key.PK}|${key.SK}`;

async function batchGet(keys: Key[]): Promise<Map<string, Record<string, any>>> {
  const found = new Map<string, Record<string, any>>();
  const unique = [...new Map(keys.map((key) => [keyId(key), key])).values()];
  for (let start = 0; start < unique.length; start += 100) {
    let request: Record<string, any> | undefined = {
      [TABLE_NAME]: { Keys: unique.slice(start, start + 100) },
    };
    while (request && Object.keys(request).length > 0) {
      const response: any = await documentClient.send(
        new BatchGetCommand({ RequestItems: request }),
      );
      for (const item of response.Responses?.[TABLE_NAME] ?? []) {
        found.set(keyId(item as Key), item);
      }
      request = response.UnprocessedKeys;
    }
  }
  return found;
}

export interface SchedulerResult {
  slot: string;
  found: number;
  queued: number;
  skipped: Record<string, number>;
  movedSlots: number;
}

export async function handler(event: { scheduledTime?: string }): Promise<SchedulerResult> {
  const now = event.scheduledTime ? new Date(event.scheduledTime) : new Date();
  const slot = slotAt(now);
  const entries: { teamId: string; userId: string }[] = [];
  let startKey: Record<string, any> | undefined;
  do {
    const page = await documentClient.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        IndexName: 'GSI3',
        KeyConditionExpression: 'GSI3PK = :slot',
        ExpressionAttributeValues: { ':slot': slot },
        ExclusiveStartKey: startKey,
      }),
    );
    for (const item of page.Items ?? []) {
      entries.push({
        teamId: item.PK.slice('TEAM#'.length),
        userId: item.SK.slice('MEMBER#'.length),
      });
    }
    startKey = page.LastEvaluatedKey;
  } while (startKey);

  const result: SchedulerResult = {
    slot,
    found: entries.length,
    queued: 0,
    skipped: {},
    movedSlots: 0,
  };
  if (entries.length === 0) {
    return result;
  }

  const records = await batchGet(
    entries.flatMap(({ teamId, userId }) => [
      { PK: teamPk(teamId), SK: META_SK },
      { PK: teamPk(teamId), SK: memberSk(userId) },
      { PK: userPk(userId), SK: PROFILE_SK },
    ]),
  );
  const checkinKeys: Key[] = [];
  const planned = entries.flatMap(({ teamId, userId }) => {
    const team = records.get(keyId({ PK: teamPk(teamId), SK: META_SK }));
    const member = records.get(keyId({ PK: teamPk(teamId), SK: memberSk(userId) }));
    const profile = records.get(keyId({ PK: userPk(userId), SK: PROFILE_SK }));
    if (!team || !member) {
      return [];
    }
    return [{ teamId, userId, team, member, profile }];
  });
  for (const entry of planned) {
    for (const offsetDays of [-1, 0, 1]) {
      const date = new Date(now.getTime() + offsetDays * 86_400_000).toISOString().slice(0, 10);
      checkinKeys.push({ PK: teamPk(entry.teamId), SK: checkinSk(date, entry.userId) });
    }
  }
  const checkins = await batchGet(checkinKeys);

  const messages: ReminderMessage[] = [];
  for (const { teamId, userId, team, member, profile } of planned) {
    const decision = planReminder({
      slot,
      now,
      workdays: team.workdays,
      reminderTime: team.reminderTime,
      timezone: member.timezone,
      email: profile?.email ?? null,
      hasCheckin: (date) =>
        checkins.has(keyId({ PK: teamPk(teamId), SK: checkinSk(date, userId) })),
    });
    if (decision.correctSlot !== slot) {
      await documentClient.send(
        new UpdateCommand({
          TableName: TABLE_NAME,
          Key: { PK: teamPk(teamId), SK: memberSk(userId) },
          UpdateExpression: 'SET GSI3PK = :slot',
          ExpressionAttributeValues: { ':slot': decision.correctSlot },
        }),
      );
      result.movedSlots++;
    }
    if (!decision.send) {
      result.skipped[decision.reason] = (result.skipped[decision.reason] ?? 0) + 1;
      continue;
    }
    messages.push({
      kind: 'reminder',
      to: profile!.email,
      name: member.name,
      teamId,
      teamName: team.name,
      date: decision.date,
      questions: team.questions,
    });
  }

  for (let start = 0; start < messages.length; start += 10) {
    const batch = messages.slice(start, start + 10);
    const response = await sqs.send(
      new SendMessageBatchCommand({
        QueueUrl: QUEUE_URL,
        Entries: batch.map((message, index) => ({
          Id: String(index),
          MessageBody: JSON.stringify(message),
        })),
      }),
    );
    result.queued += response.Successful?.length ?? 0;
    if (response.Failed?.length) {
      console.error(`queue rejected ${response.Failed.length} reminder(s)`);
    }
  }
  console.log(JSON.stringify(result));
  return result;
}
