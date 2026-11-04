import { ApiGatewayV2Client, GetApisCommand } from '@aws-sdk/client-apigatewayv2';
import {
  CloudWatchClient,
  GetMetricDataCommand,
  type MetricDataQuery,
} from '@aws-sdk/client-cloudwatch';
import { CloudWatchLogsClient, DescribeLogGroupsCommand } from '@aws-sdk/client-cloudwatch-logs';
import { LambdaClient, ListFunctionsCommand } from '@aws-sdk/client-lambda';
import { mkdirSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { loadOutputs } from './shared.js';

/*
 * us-east-1 list prices, approximate (verify on the AWS pricing pages). Lambda,
 * SQS and API requests are priced without the free tier so the projection shows
 * what the workload would cost on an account that has used it up.
 */
const PRICES = {
  readRequestUnit: 0.125 / 1e6,
  writeRequestUnit: 0.625 / 1e6,
  httpApiRequest: 1.0 / 1e6,
  lambdaRequest: 0.2 / 1e6,
  lambdaArmGbSecond: 0.0000133334,
  sqsRequest: 0.4 / 1e6,
  logIngestGb: 0.5,
  sesEmail: 0.1 / 1000,
};
const TARGET_MONTH = { readUnits: 13_000_000, writeUnits: 2_000_000 };
const LAMBDA_MEMORY_GB = 0.25;
const MONTH_HOURS = 24 * 30;

const { values } = parseArgs({ options: { from: { type: 'string' }, to: { type: 'string' } } });
if (!values.from || !values.to) {
  console.error('usage: npm run costs -- --from 2026-11-04T12:00:00Z --to 2026-11-04T13:00:00Z');
  process.exit(1);
}
const from = new Date(values.from);
const to = new Date(values.to);
const hours = (to.getTime() - from.getTime()) / 3_600_000;
const outputs = loadOutputs();
const region = { region: outputs.Region };
const cloudwatch = new CloudWatchClient(region);

const [functions, apis, logGroups] = await Promise.all([
  new LambdaClient(region).send(new ListFunctionsCommand({ MaxItems: 50 })),
  new ApiGatewayV2Client(region).send(new GetApisCommand({})),
  new CloudWatchLogsClient(region).send(
    new DescribeLogGroupsCommand({ logGroupNamePrefix: 'StandupLogStack' }),
  ),
]);
const appFunctions = (functions.Functions ?? [])
  .map((fn) => fn.FunctionName!)
  .filter((name) => /^StandupLogStack-(Api|Reminder|Stats|Digest)/.test(name));
const apiId = (apis.Items ?? []).find((api) => api.ApiEndpoint === outputs.ApiUrl)!.ApiId!;

const queries: MetricDataQuery[] = [];
const metric = (
  id: string,
  namespace: string,
  name: string,
  dimensions: Record<string, string>,
  stat = 'Sum',
) => {
  queries.push({
    Id: id,
    MetricStat: {
      Metric: {
        Namespace: namespace,
        MetricName: name,
        Dimensions: Object.entries(dimensions).map(([Name, Value]) => ({ Name, Value })),
      },
      Period: 60,
      Stat: stat,
    },
  });
};
const table = { TableName: outputs.TableName };
metric('tableRead', 'AWS/DynamoDB', 'ConsumedReadCapacityUnits', table);
metric('tableWrite', 'AWS/DynamoDB', 'ConsumedWriteCapacityUnits', table);
metric('throttles', 'AWS/DynamoDB', 'ThrottledRequests', table);
for (const index of ['GSI1', 'GSI2', 'GSI3']) {
  metric(`${index.toLowerCase()}Read`, 'AWS/DynamoDB', 'ConsumedReadCapacityUnits', {
    ...table,
    GlobalSecondaryIndexName: index,
  });
  metric(`${index.toLowerCase()}Write`, 'AWS/DynamoDB', 'ConsumedWriteCapacityUnits', {
    ...table,
    GlobalSecondaryIndexName: index,
  });
}
metric('apiRequests', 'AWS/ApiGateway', 'Count', { ApiId: apiId });
appFunctions.forEach((name, index) => {
  metric(`lambdaInvocations${index}`, 'AWS/Lambda', 'Invocations', { FunctionName: name });
  metric(`lambdaDuration${index}`, 'AWS/Lambda', 'Duration', { FunctionName: name });
});
(logGroups.logGroups ?? []).forEach((group, index) => {
  metric(`logBytes${index}`, 'AWS/Logs', 'IncomingBytes', { LogGroupName: group.logGroupName! });
});
metric('sesSends', 'AWS/SES', 'Send', {});

const totals: Record<string, number> = {};
for (let start = 0; start < queries.length; start += 400) {
  let nextToken: string | undefined;
  do {
    const page = await cloudwatch.send(
      new GetMetricDataCommand({
        MetricDataQueries: queries.slice(start, start + 400),
        StartTime: from,
        EndTime: to,
        NextToken: nextToken,
      }),
    );
    for (const result of page.MetricDataResults ?? []) {
      totals[result.Id!] =
        (totals[result.Id!] ?? 0) + (result.Values ?? []).reduce((sum, value) => sum + value, 0);
    }
    nextToken = page.NextToken;
  } while (nextToken);
}
const sumOf = (prefix: string) =>
  Object.entries(totals)
    .filter(([id]) => id.startsWith(prefix))
    .reduce((sum, [, value]) => sum + value, 0);

const measured = {
  readUnits: totals.tableRead + totals.gsi1Read + totals.gsi2Read + totals.gsi3Read,
  writeUnits: totals.tableWrite + totals.gsi1Write + totals.gsi2Write + totals.gsi3Write,
  readUnitsByIndex: {
    table: totals.tableRead,
    GSI1: totals.gsi1Read,
    GSI2: totals.gsi2Read,
    GSI3: totals.gsi3Read,
  },
  writeUnitsByIndex: {
    table: totals.tableWrite,
    GSI1: totals.gsi1Write,
    GSI2: totals.gsi2Write,
    GSI3: totals.gsi3Write,
  },
  throttles: totals.throttles,
  apiRequests: totals.apiRequests,
  lambdaInvocations: sumOf('lambdaInvocations'),
  lambdaGbSeconds: (sumOf('lambdaDuration') / 1000) * LAMBDA_MEMORY_GB,
  logGb: sumOf('logBytes') / 1e9,
  emails: totals.sesSends,
};
const perMonth = (value: number) => (value / hours) * MONTH_HOURS;
const money = (value: number) => Number(value.toFixed(4));
const projected = {
  readUnits: Math.round(perMonth(measured.readUnits)),
  writeUnits: Math.round(perMonth(measured.writeUnits)),
  apiRequests: Math.round(perMonth(measured.apiRequests)),
  lambdaInvocations: Math.round(perMonth(measured.lambdaInvocations)),
  lambdaGbSeconds: Math.round(perMonth(measured.lambdaGbSeconds)),
  logGb: Number(perMonth(measured.logGb).toFixed(3)),
  emails: Math.round(perMonth(measured.emails)),
};
const costs = {
  dynamodbReads: money(projected.readUnits * PRICES.readRequestUnit),
  dynamodbWrites: money(projected.writeUnits * PRICES.writeRequestUnit),
  apiGateway: money(projected.apiRequests * PRICES.httpApiRequest),
  lambda: money(
    projected.lambdaInvocations * PRICES.lambdaRequest +
      projected.lambdaGbSeconds * PRICES.lambdaArmGbSecond,
  ),
  cloudwatchLogs: money(projected.logGb * PRICES.logIngestGb),
  ses: money(projected.emails * PRICES.sesEmail),
};
const total = money(Object.values(costs).reduce((sum, value) => sum + value, 0));
const report = {
  window: { from: from.toISOString(), to: to.toISOString(), hours },
  rates: {
    readUnitsPerSecond: Number((measured.readUnits / (hours * 3600)).toFixed(2)),
    writeUnitsPerSecond: Number((measured.writeUnits / (hours * 3600)).toFixed(2)),
    targetReadUnitsPerSecond: Number((TARGET_MONTH.readUnits / (MONTH_HOURS * 3600)).toFixed(2)),
    targetWriteUnitsPerSecond: Number((TARGET_MONTH.writeUnits / (MONTH_HOURS * 3600)).toFixed(2)),
  },
  measured,
  projectedMonth: projected,
  projectedMonthlyCostUsd: { ...costs, total },
  dynamodbAtTargetVolumeUsd: money(
    TARGET_MONTH.readUnits * PRICES.readRequestUnit + TARGET_MONTH.writeUnits * PRICES.writeRequestUnit,
  ),
};
mkdirSync(new URL('../results/', import.meta.url), { recursive: true });
writeFileSync(
  new URL(`../results/costs-${from.toISOString().replace(/[:.]/g, '-')}.json`, import.meta.url),
  JSON.stringify(report, null, 2) + '\n',
);
console.log(JSON.stringify(report, null, 2));
