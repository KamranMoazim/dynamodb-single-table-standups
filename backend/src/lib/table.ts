import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

export const TABLE_NAME = process.env.TABLE_NAME ?? 'standuplog';
export const dynamoClient = new DynamoDBClient({});
export const documentClient = DynamoDBDocumentClient.from(dynamoClient, {
  marshallOptions: { removeUndefinedValues: true },
});
