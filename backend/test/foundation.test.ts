import { CloudWatchLogsClient, DescribeLogGroupsCommand } from '@aws-sdk/client-cloudwatch-logs';
import { DescribeTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { call, check, createTestUser, finish, loadOutputs } from './helpers.js';

const outputs = loadOutputs();
const user = await createTestUser('foundation');

try {
  let response = await call('GET', '/health');
  check(
    'health public',
    response.status === 200 &&
      response.body.table.status === 'ACTIVE' &&
      JSON.stringify(response.body.table.indexes) === JSON.stringify(['GSI1', 'GSI2', 'GSI3']),
    response,
  );

  response = await call('GET', '/me');
  check('me needs token', response.status === 401, response);

  response = await call('GET', '/me', { token: 'not-a-jwt' });
  check('garbage token', response.status === 401, response);

  response = await call('GET', '/me', { token: user.token });
  check(
    'me with token',
    response.status === 200 && response.body.userId === user.userId && response.body.email === user.email,
    response,
  );

  response = await call('GET', '/nope', { token: user.token });
  check('unknown route', response.status === 404 && response.body.error === 'not_found', response);

  for (const origin of ['http://localhost:5173', outputs.SiteUrl]) {
    response = await call('OPTIONS', '/me', {
      headers: {
        origin,
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'authorization',
      },
    });
    check(
      `cors preflight from ${origin}`,
      response.status === 204 && response.headers.get('access-control-allow-origin') === origin,
      { status: response.status, allow: response.headers.get('access-control-allow-origin') },
    );
  }

  const logsClient = new CloudWatchLogsClient({ region: outputs.Region });
  const { logGroups = [] } = await logsClient.send(
    new DescribeLogGroupsCommand({ logGroupNamePrefix: 'StandupLogStack' }),
  );
  check(
    'log retention live',
    logGroups.length >= 2 && logGroups.every((group) => group.retentionInDays === 1),
    logGroups.map((group) => [group.logGroupName, group.retentionInDays]),
  );

  const dynamo = new DynamoDBClient({ region: outputs.Region });
  const { Table } = await dynamo.send(new DescribeTableCommand({ TableName: outputs.TableName }));
  check(
    'table on demand, aws owned key',
    Table?.BillingModeSummary?.BillingMode === 'PAY_PER_REQUEST' && !Table?.SSEDescription,
    { billing: Table?.BillingModeSummary, sse: Table?.SSEDescription },
  );

  response = await call('GET', outputs.SiteUrl);
  check(
    'site serves index',
    response.status === 200 && String(response.body).includes('<div id="root">'),
    response.status,
  );

  response = await call('GET', `${outputs.SiteUrl}/config.json`);
  check(
    'config json',
    response.status === 200 &&
      response.body.apiUrl === outputs.ApiUrl &&
      response.body.userPoolId === outputs.UserPoolId &&
      response.body.userPoolClientId === outputs.UserPoolClientId,
    response.body,
  );

  response = await call('GET', `${outputs.SiteUrl}/teams/x`);
  check(
    'spa deep link',
    response.status === 200 && String(response.body).includes('<div id="root">'),
    response.status,
  );

  response = await call('GET', `https://${outputs.SiteBucketName}.s3.amazonaws.com/index.html`);
  check('bucket not public', response.status === 403, response.status);
} finally {
  await user.remove();
}

finish();
