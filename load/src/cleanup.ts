import {
  AdminDeleteUserCommand,
  ListUsersCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { BatchWriteCommand, DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { rmSync } from 'node:fs';
import { cognitoClient, inBatches, loadOutputs, readState } from './shared.js';

const outputs = loadOutputs();
const cognito = cognitoClient(outputs);
const documentClient = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: outputs.Region, maxAttempts: 8 }),
);
const state = readState();

async function deletePartition(partitionKey: string): Promise<number> {
  let deleted = 0;
  let startKey: Record<string, any> | undefined;
  do {
    const page = await documentClient.send(
      new QueryCommand({
        TableName: outputs.TableName,
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: { ':pk': partitionKey },
        ProjectionExpression: 'PK, SK',
        ExclusiveStartKey: startKey,
      }),
    );
    const items = page.Items ?? [];
    for (let start = 0; start < items.length; start += 25) {
      let request: Record<string, any> | undefined = {
        [outputs.TableName]: items
          .slice(start, start + 25)
          .map((item) => ({ DeleteRequest: { Key: { PK: item.PK, SK: item.SK } } })),
      };
      while (request && Object.keys(request).length > 0) {
        const response: any = await documentClient.send(
          new BatchWriteCommand({ RequestItems: request }),
        );
        request = response.UnprocessedItems;
      }
    }
    deleted += items.length;
    startKey = page.LastEvaluatedKey;
  } while (startKey);
  return deleted;
}

if (state) {
  const partitions = [
    ...state.users.filter(Boolean).map((user) => `USER#${user.userId}`),
    ...state.workspaces.flatMap((workspace) => [
      `WS#${workspace.workspaceId}`,
      `INVITE#${workspace.inviteCode}`,
    ]),
    ...state.teams.map((team) => `TEAM#${team.teamId}`),
  ];
  let items = 0;
  await inBatches(partitions, 8, async (partition) => {
    const deleted = await deletePartition(partition);
    items += deleted;
  });
  console.log(`deleted ${items} items in ${partitions.length} partitions`);
}

const emails: string[] = [];
let paginationToken: string | undefined;
do {
  const page = await cognito.send(
    new ListUsersCommand({
      UserPoolId: outputs.UserPoolId,
      Filter: 'email ^= "success+sim-"',
      PaginationToken: paginationToken,
    }),
  );
  emails.push(...(page.Users ?? []).map((user) => user.Username!));
  paginationToken = page.PaginationToken;
} while (paginationToken);
await inBatches(emails, 5, async (username) => {
  await cognito.send(
    new AdminDeleteUserCommand({ UserPoolId: outputs.UserPoolId, Username: username }),
  );
});
console.log(`deleted ${emails.length} Cognito users`);
rmSync(new URL('../state.json', import.meta.url), { force: true });
