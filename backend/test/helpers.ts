import {
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminSetUserPasswordCommand,
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

export interface StackOutputs {
  Region: string;
  TableName: string;
  UserPoolId: string;
  UserPoolClientId: string;
  ApiUrl: string;
  SiteUrl: string;
  SiteBucketName: string;
}

export function loadOutputs(): StackOutputs {
  const path = new URL('../../infra/cdk-outputs.json', import.meta.url);
  const all = JSON.parse(readFileSync(path, 'utf8')) as Record<string, StackOutputs>;
  return all.StandupLogStack;
}

let passed = 0;
let failed = 0;

export function check(name: string, ok: boolean, extra?: unknown): void {
  if (ok) {
    passed++;
  } else {
    failed++;
  }
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ' ' + JSON.stringify(extra)}`);
}

export function finish(): never {
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

export async function call(
  method: string,
  path: string,
  options: { body?: unknown; token?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: any; headers: Headers }> {
  const outputs = loadOutputs();
  const url = path.startsWith('http') ? path : outputs.ApiUrl + path;
  const response = await fetch(url, {
    method,
    headers: {
      ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...options.headers,
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  let body: any = text;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, body, headers: response.headers };
}

export interface TestUser {
  userId: string;
  email: string;
  token: string;
  remove: () => Promise<void>;
}

export async function createTestUser(label: string): Promise<TestUser> {
  const outputs = loadOutputs();
  const cognito = new CognitoIdentityProviderClient({ region: outputs.Region });
  const email = `test+${label}-${randomBytes(4).toString('hex')}@example.com`;
  const password = `Pw-${randomBytes(12).toString('hex')}`;
  const created = await cognito.send(
    new AdminCreateUserCommand({
      UserPoolId: outputs.UserPoolId,
      Username: email,
      MessageAction: 'SUPPRESS',
      UserAttributes: [
        { Name: 'email', Value: email },
        { Name: 'email_verified', Value: 'true' },
      ],
    }),
  );
  await cognito.send(
    new AdminSetUserPasswordCommand({
      UserPoolId: outputs.UserPoolId,
      Username: email,
      Password: password,
      Permanent: true,
    }),
  );
  const auth = await cognito.send(
    new InitiateAuthCommand({
      ClientId: outputs.UserPoolClientId,
      AuthFlow: 'USER_PASSWORD_AUTH',
      AuthParameters: { USERNAME: email, PASSWORD: password },
    }),
  );
  const userId = created.User!.Attributes!.find((attribute) => attribute.Name === 'sub')!.Value!;
  return {
    userId,
    email,
    token: auth.AuthenticationResult!.IdToken!,
    remove: async () => {
      await cognito.send(
        new AdminDeleteUserCommand({ UserPoolId: outputs.UserPoolId, Username: email }),
      );
    },
  };
}

export async function deletePartitions(
  region: string,
  tableName: string,
  partitionKeys: string[],
): Promise<void> {
  const { DynamoDBClient } = await import('@aws-sdk/client-dynamodb');
  const { BatchWriteCommand, DynamoDBDocumentClient, QueryCommand } = await import(
    '@aws-sdk/lib-dynamodb'
  );
  const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
  for (const partitionKey of partitionKeys) {
    const { Items = [] } = await documentClient.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: { ':pk': partitionKey },
        ProjectionExpression: 'PK, SK',
      }),
    );
    for (let start = 0; start < Items.length; start += 25) {
      await documentClient.send(
        new BatchWriteCommand({
          RequestItems: {
            [tableName]: Items.slice(start, start + 25).map((item) => ({
              DeleteRequest: { Key: { PK: item.PK, SK: item.SK } },
            })),
          },
        }),
      );
    }
  }
}

export async function eventually(probe: () => Promise<boolean>, attempts = 10): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (await probe()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}
