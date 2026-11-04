import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import type { DynamoDBBatchResponse, DynamoDBStreamEvent } from 'aws-lambda';
import { isConditionFailure } from '../lib/dynamo-errors.js';
import { META_SK, statsSk, teamPk, userPk } from '../lib/keys.js';
import { TABLE_NAME, documentClient } from '../lib/table.js';
import { EMPTY_STATS, nextStats, type Stats } from './streak.js';

async function applyCheckin(teamId: string, userId: string, date: string): Promise<void> {
  const { Item: team } = await documentClient.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { PK: teamPk(teamId), SK: META_SK },
      ProjectionExpression: 'workdays',
    }),
  );
  if (!team) {
    return;
  }
  const key = { PK: userPk(userId), SK: statsSk(teamId) };
  for (let attempt = 0; attempt < 3; attempt++) {
    const { Item } = await documentClient.send(
      new GetCommand({ TableName: TABLE_NAME, Key: key, ConsistentRead: true }),
    );
    const previous: Stats = Item ? { ...EMPTY_STATS, ...(Item as Partial<Stats>) } : EMPTY_STATS;
    const next = nextStats(previous, date, team.workdays);
    if (!next) {
      return;
    }
    try {
      await documentClient.send(
        new PutCommand({
          TableName: TABLE_NAME,
          Item: { ...key, teamId, ...next, updatedAt: new Date().toISOString() },
          ConditionExpression: Item ? 'lastDate = :seen' : 'attribute_not_exists(PK)',
          ExpressionAttributeValues: Item ? { ':seen': previous.lastDate } : undefined,
        }),
      );
      return;
    } catch (error) {
      if (!isConditionFailure(error)) {
        throw error;
      }
    }
  }
  throw new Error(`stats update for team ${teamId} kept conflicting`);
}

export async function handler(event: DynamoDBStreamEvent): Promise<DynamoDBBatchResponse> {
  const failures: DynamoDBBatchResponse['batchItemFailures'] = [];
  for (const record of event.Records) {
    const image = record.dynamodb?.NewImage;
    if (record.eventName !== 'INSERT' || !image) {
      continue;
    }
    const checkin = unmarshall(image as never);
    try {
      await applyCheckin(checkin.teamId, checkin.userId, checkin.date);
    } catch (error) {
      console.error(`stats failed team=${checkin.teamId}: ${(error as Error).message}`);
      failures.push({ itemIdentifier: record.dynamodb!.SequenceNumber! });
    }
  }
  return { batchItemFailures: failures };
}
