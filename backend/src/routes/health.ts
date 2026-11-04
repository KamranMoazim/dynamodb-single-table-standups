import { DescribeTableCommand } from '@aws-sdk/client-dynamodb';
import type { Route } from '../lib/router.js';
import { TABLE_NAME, dynamoClient } from '../lib/table.js';

export const healthRoutes: Route[] = [
  {
    method: 'GET',
    pattern: '/health',
    auth: false,
    handler: async () => {
      const { Table } = await dynamoClient.send(
        new DescribeTableCommand({ TableName: TABLE_NAME }),
      );
      const indexes = (Table?.GlobalSecondaryIndexes ?? []).map((index) => index.IndexName!).sort();
      return {
        status: 200,
        body: { ok: true, table: { name: TABLE_NAME, status: Table?.TableStatus, indexes } },
      };
    },
  },
];
