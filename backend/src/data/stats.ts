import { BatchGetCommand } from '@aws-sdk/lib-dynamodb';
import { PROFILE_SK, statsSk, userPk } from '../lib/keys.js';
import { TABLE_NAME, documentClient } from '../lib/table.js';
import { EMPTY_STATS, type Stats } from '../stats/streak.js';

async function batchGetItems(keys: { PK: string; SK: string }[]): Promise<Record<string, any>[]> {
  const items: Record<string, any>[] = [];
  for (let start = 0; start < keys.length; start += 100) {
    let request: Record<string, any> | undefined = {
      [TABLE_NAME]: { Keys: keys.slice(start, start + 100) },
    };
    while (request && Object.keys(request).length > 0) {
      const response: any = await documentClient.send(
        new BatchGetCommand({ RequestItems: request }),
      );
      items.push(...(response.Responses?.[TABLE_NAME] ?? []));
      request = response.UnprocessedKeys;
    }
  }
  return items;
}

export async function getTeamStats(teamId: string, userIds: string[]): Promise<Map<string, Stats>> {
  const items = await batchGetItems(
    userIds.map((userId) => ({ PK: userPk(userId), SK: statsSk(teamId) })),
  );
  return new Map(
    items.map((item) => [item.PK.slice('USER#'.length), { ...EMPTY_STATS, ...item } as Stats]),
  );
}

export async function getEmails(userIds: string[]): Promise<Map<string, string>> {
  const items = await batchGetItems(
    userIds.map((userId) => ({ PK: userPk(userId), SK: PROFILE_SK })),
  );
  return new Map(
    items.filter((item) => item.email).map((item) => [item.userId, item.email as string]),
  );
}
