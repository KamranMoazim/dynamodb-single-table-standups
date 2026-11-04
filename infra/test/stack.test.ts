import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StandupLogStack } from '../lib/standuplog-stack.js';

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, extra?: unknown): void {
  if (ok) {
    passed++;
  } else {
    failed++;
  }
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ' ' + JSON.stringify(extra)}`);
}

const distPath = mkdtempSync(join(tmpdir(), 'standuplog-dist-'));
writeFileSync(join(distPath, 'index.html'), '<div id="root"></div>');
const stack = new StandupLogStack(new App(), 'TestStack', {
  env: { account: '111111111111', region: 'us-east-1' },
  alertEmail: 'test@example.com',
  senderEmail: 'StandupLog <noreply@example.org>',
  clientDistPath: distPath,
});
const template = Template.fromStack(stack);
const resources = template.toJSON().Resources as Record<
  string,
  { Type: string; DeletionPolicy?: string; Properties: any }
>;
const ofType = (type: string) =>
  Object.values(resources).filter((resource) => resource.Type === type);
const json = (value: unknown) => JSON.stringify(value);

const [table] = ofType('AWS::DynamoDB::GlobalTable');
const tableProps = table?.Properties ?? {};
check(
  'table on demand',
  tableProps.TableName === 'standuplog' &&
    tableProps.BillingMode === 'PAY_PER_REQUEST' &&
    json(tableProps.KeySchema) ===
      json([
        { AttributeName: 'PK', KeyType: 'HASH' },
        { AttributeName: 'SK', KeyType: 'RANGE' },
      ]),
  tableProps,
);

const indexes = Object.fromEntries(
  (tableProps.GlobalSecondaryIndexes ?? []).map((index: any) => [index.IndexName, index]),
);
const feedAttributes = ['answers', 'authorName', 'blocker', 'date', 'teamId', 'userId'];
const includes = (name: string) =>
  indexes[name]?.Projection.ProjectionType === 'INCLUDE' &&
  json([...indexes[name].Projection.NonKeyAttributes].sort()) === json(feedAttributes);
check(
  'three gsis with projections',
  Object.keys(indexes).length === 3 &&
    includes('GSI1') &&
    includes('GSI2') &&
    indexes.GSI3?.Projection.ProjectionType === 'KEYS_ONLY',
  indexes,
);
check(
  'no customer kms key',
  ofType('AWS::KMS::Key').length === 0 && !json(tableProps).includes('KMSMasterKeyId'),
);
check('no secrets', ofType('AWS::SecretsManager::Secret').length === 0);

const [pool] = ofType('AWS::Cognito::UserPool');
check(
  'user pool email sign in',
  json(pool?.Properties.UsernameAttributes) === json(['email']) &&
    json(pool?.Properties.AutoVerifiedAttributes) === json(['email']),
  pool?.Properties,
);
const [client] = ofType('AWS::Cognito::UserPoolClient');
const flows: string[] = client?.Properties.ExplicitAuthFlows ?? [];
check(
  'pool client auth flows',
  ['ALLOW_USER_PASSWORD_AUTH', 'ALLOW_USER_SRP_AUTH', 'ALLOW_REFRESH_TOKEN_AUTH'].every((flow) =>
    flows.includes(flow),
  ) && client?.Properties.GenerateSecret === false,
  client?.Properties,
);

const budgetList = ofType('AWS::Budgets::Budget');
check(
  'budgets 1 and 2',
  json(budgetList.map((budget) => budget.Properties.Budget.BudgetLimit.Amount).sort()) ===
    json([1, 2]) &&
    budgetList.every(
      (budget) =>
        budget.Properties.Budget.TimeUnit === 'MONTHLY' &&
        json(budget.Properties.Budget.CostFilters.TagKeyValue) ===
          json(['user:project$standuplog']) &&
        budget.Properties.NotificationsWithSubscribers[0].Notification.NotificationType ===
          'ACTUAL' &&
        budget.Properties.NotificationsWithSubscribers[0].Subscribers[0].Address ===
          'test@example.com',
    ),
  budgetList,
);

const keeps = Object.entries(resources).filter(
  ([, resource]) => resource.DeletionPolicy && resource.DeletionPolicy !== 'Delete',
);
check(
  'everything deletes',
  keeps.length === 0,
  keeps.map(([id]) => id),
);

const logGroups = ofType('AWS::Logs::LogGroup');
check(
  'log retention one day',
  logGroups.length >= 2 && logGroups.every((group) => group.Properties.RetentionInDays === 1),
  logGroups.map((group) => group.Properties.RetentionInDays),
);

const functions = ofType('AWS::Lambda::Function').filter(
  (fn) => fn.Properties.Environment?.Variables?.TABLE_NAME,
);
check(
  'app lambdas',
  functions.length === 5 &&
    functions.every(
      (fn) =>
        fn.Properties.Runtime === 'nodejs22.x' &&
        json(fn.Properties.Architectures) === json(['arm64']) &&
        fn.Properties.Environment.Variables.LOG_LEVEL === 'INFO',
    ),
  functions.map((fn) => fn.Properties),
);

const schedules = ofType('AWS::Scheduler::Schedule');
const schedule = schedules.find((item) => item.Properties.ScheduleExpression.includes('0/15'));
const digestSchedule = schedules.find(
  (item) => item.Properties.ScheduleExpression === 'cron(0 8 ? * MON *)',
);
check(
  'weekly digest schedule',
  schedules.length === 2 &&
    digestSchedule?.Properties.Target.RetryPolicy.MaximumRetryAttempts === 0,
  schedules.map((item) => item.Properties.ScheduleExpression),
);
check(
  'table stream new image',
  tableProps.StreamSpecification?.StreamViewType === 'NEW_IMAGE',
  tableProps.StreamSpecification,
);
check(
  'reminder schedule every 15 minutes, no retries',
  schedule?.Properties.ScheduleExpression === 'cron(0/15 * * * ? *)' &&
    schedule.Properties.ScheduleExpressionTimezone === 'UTC' &&
    schedule.Properties.Target.RetryPolicy.MaximumRetryAttempts === 0 &&
    schedule.Properties.Target.Input.includes('<aws.scheduler.scheduled-time>'),
  schedule?.Properties,
);
check(
  'scheduler lambda async retries off',
  ofType('AWS::Lambda::EventInvokeConfig').some(
    (config) => config.Properties.MaximumRetryAttempts === 0,
  ),
);

const queues = ofType('AWS::SQS::Queue');
check(
  'reminder queue with dead letters',
  queues.length === 2 &&
    queues.some((queue) => queue.Properties.RedrivePolicy?.maxReceiveCount === 3),
  queues.map((queue) => queue.Properties),
);

const mappings = ofType('AWS::Lambda::EventSourceMapping');
const mapping = mappings.find((item) => item.Properties.BatchSize === 10);
const streamMapping = mappings.find((item) => item.Properties.StartingPosition === 'LATEST');
check(
  'stats stream only sees new check-ins',
  json(streamMapping?.Properties.FilterCriteria) ===
    json({
      Filters: [
        {
          Pattern: json({
            eventName: ['INSERT'],
            dynamodb: { NewImage: { GSI1PK: { S: [{ exists: true }] } } },
          }),
        },
      ],
    }) &&
    streamMapping?.Properties.BisectBatchOnFunctionError === true &&
    streamMapping?.Properties.MaximumRetryAttempts === 2 &&
    json(streamMapping?.Properties.FunctionResponseTypes) === json(['ReportBatchItemFailures']),
  streamMapping?.Properties,
);
check(
  'sender reports partial batch failures',
  mapping?.Properties.BatchSize === 10 &&
    json(mapping.Properties.FunctionResponseTypes) === json(['ReportBatchItemFailures']),
  mapping?.Properties,
);

const policies = json(ofType('AWS::IAM::Policy').map((policy) => policy.Properties.PolicyDocument));
check(
  'ses send scoped to sender domain',
  policies.includes('ses:SendEmail') &&
    policies.includes(':identity/example.org') &&
    !policies.includes('"ses:*"'),
);

const [authorizer] = ofType('AWS::ApiGatewayV2::Authorizer');
check(
  'jwt authorizer',
  authorizer?.Properties.AuthorizerType === 'JWT' &&
    json(authorizer.Properties.JwtConfiguration.Issuer).includes(
      'cognito-idp.us-east-1.amazonaws.com',
    ),
  authorizer?.Properties,
);

const routes = Object.fromEntries(
  ofType('AWS::ApiGatewayV2::Route').map((route) => [route.Properties.RouteKey, route.Properties]),
);
check(
  'health is public',
  routes['GET /health']?.AuthorizationType === 'NONE' &&
    ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].every(
      (method) => routes[`${method} /{proxy+}`]?.AuthorizationType === 'JWT',
    ) &&
    !routes['ANY /{proxy+}'] &&
    !routes['OPTIONS /{proxy+}'],
  Object.keys(routes),
);

const [api] = ofType('AWS::ApiGatewayV2::Api');
const cors = api?.Properties.CorsConfiguration ?? {};
check(
  'cors',
  ['authorization', 'content-type'].every((header) => cors.AllowHeaders?.includes(header)) &&
    cors.AllowOrigins?.includes('http://localhost:5173') &&
    json(cors.AllowOrigins).includes('SiteDistribution'),
  cors,
);

const [bucket] = ofType('AWS::S3::Bucket');
const block = bucket?.Properties.PublicAccessBlockConfiguration ?? {};
check(
  'site bucket private',
  block.BlockPublicAcls &&
    block.BlockPublicPolicy &&
    block.IgnorePublicAcls &&
    block.RestrictPublicBuckets,
  block,
);

const [distribution] = ofType('AWS::CloudFront::Distribution');
const distributionConfig = distribution?.Properties.DistributionConfig ?? {};
const errorResponses = distributionConfig.CustomErrorResponses ?? [];
check(
  'cloudfront oac',
  ofType('AWS::CloudFront::OriginAccessControl').length === 1 &&
    distributionConfig.DefaultRootObject === 'index.html' &&
    distributionConfig.DefaultCacheBehavior.ViewerProtocolPolicy === 'redirect-to-https' &&
    [403, 404].every((code) =>
      errorResponses.some(
        (response: any) =>
          response.ErrorCode === code &&
          response.ResponseCode === 200 &&
          response.ResponsePagePath === '/index.html',
      ),
    ),
  distributionConfig,
);

const deployments = ofType('Custom::CDKBucketDeployment');
const markers = json(deployments.map((deployment) => deployment.Properties.SourceMarkers));
check(
  'config json deployed',
  deployments.length === 1 &&
    ['ApiEndpoint', 'UserPool6', 'UserPoolWebClient'].every((key) => markers.includes(key)),
  markers,
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
