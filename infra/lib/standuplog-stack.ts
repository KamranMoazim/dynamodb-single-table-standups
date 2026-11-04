import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpJwtAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as budgets from 'aws-cdk-lib/aws-budgets';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as iam from 'aws-cdk-lib/aws-iam';
import { DynamoEventSource, SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';
import { fileURLToPath } from 'node:url';

export interface StandupLogStackProps extends StackProps {
  alertEmail: string;
  senderEmail: string;
  clientDistPath: string;
}

const FEED_ATTRIBUTES = ['teamId', 'userId', 'date', 'authorName', 'answers', 'blocker'];
const LOCAL_ORIGIN = 'http://localhost:5173';
const backendPath = (relative: string) =>
  fileURLToPath(new URL(`../../backend/${relative}`, import.meta.url));

export class StandupLogStack extends Stack {
  readonly table: dynamodb.TableV2;
  readonly userPool: cognito.UserPool;
  readonly userPoolClient: cognito.UserPoolClient;

  constructor(scope: Construct, id: string, props: StandupLogStackProps) {
    super(scope, id, props);

    this.table = new dynamodb.TableV2(this, 'Table', {
      tableName: 'standuplog',
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      dynamoStream: dynamodb.StreamViewType.NEW_IMAGE,
      removalPolicy: RemovalPolicy.DESTROY,
      globalSecondaryIndexes: [
        this.index('GSI1', dynamodb.ProjectionType.INCLUDE),
        this.index('GSI2', dynamodb.ProjectionType.INCLUDE),
        this.index('GSI3', dynamodb.ProjectionType.KEYS_ONLY),
      ],
    });

    this.userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: 'standuplog-users',
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      autoVerify: { email: true },
      passwordPolicy: { minLength: 8 },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    this.userPoolClient = this.userPool.addClient('WebClient', {
      authFlows: { userPassword: true, userSrp: true },
      generateSecret: false,
    });

    const site = this.site();
    const siteOrigin = `https://${site.distribution.distributionDomainName}`;

    const apiFunction = this.lambdaFunction('ApiFunction', 'src/handlers/api.ts');
    this.table.grantReadWriteData(apiFunction);

    const api = new apigwv2.HttpApi(this, 'HttpApi', {
      apiName: 'standuplog-api',
      corsPreflight: {
        allowOrigins: [LOCAL_ORIGIN, siteOrigin],
        allowHeaders: ['authorization', 'content-type'],
        allowMethods: [
          apigwv2.CorsHttpMethod.GET,
          apigwv2.CorsHttpMethod.POST,
          apigwv2.CorsHttpMethod.PUT,
          apigwv2.CorsHttpMethod.PATCH,
          apigwv2.CorsHttpMethod.DELETE,
        ],
        maxAge: Duration.hours(1),
      },
    });
    const integration = new HttpLambdaIntegration('ApiIntegration', apiFunction);
    const authorizer = new HttpJwtAuthorizer(
      'CognitoAuthorizer',
      `https://cognito-idp.${this.region}.amazonaws.com/${this.userPool.userPoolId}`,
      { jwtAudience: [this.userPoolClient.userPoolClientId] },
    );
    api.addRoutes({ path: '/health', methods: [apigwv2.HttpMethod.GET], integration });
    api.addRoutes({
      path: '/{proxy+}',
      // ANY would route OPTIONS through the authorizer and break CORS preflight.
      methods: [
        apigwv2.HttpMethod.GET,
        apigwv2.HttpMethod.POST,
        apigwv2.HttpMethod.PUT,
        apigwv2.HttpMethod.PATCH,
        apigwv2.HttpMethod.DELETE,
      ],
      integration,
      authorizer,
    });
    const apiUrl = api.apiEndpoint;

    new s3deploy.BucketDeployment(this, 'SiteDeployment', {
      destinationBucket: site.bucket,
      sources: [
        s3deploy.Source.asset(props.clientDistPath),
        s3deploy.Source.jsonData('config.json', {
          region: this.region,
          apiUrl,
          userPoolId: this.userPool.userPoolId,
          userPoolClientId: this.userPoolClient.userPoolClientId,
        }),
      ],
      distribution: site.distribution,
      distributionPaths: ['/*'],
      logGroup: this.logGroup('SiteDeploymentLogs'),
    });

    const emailQueue = this.reminders(props.senderEmail, siteOrigin);
    this.streaksAndDigest(emailQueue);

    this.budget('Budget1', 1, props.alertEmail);
    this.budget('Budget2', 2, props.alertEmail);

    new CfnOutput(this, 'Region', { value: this.region });
    new CfnOutput(this, 'TableName', { value: this.table.tableName });
    new CfnOutput(this, 'UserPoolId', { value: this.userPool.userPoolId });
    new CfnOutput(this, 'UserPoolClientId', { value: this.userPoolClient.userPoolClientId });
    new CfnOutput(this, 'ApiUrl', { value: apiUrl });
    new CfnOutput(this, 'SiteUrl', { value: siteOrigin });
    new CfnOutput(this, 'SiteBucketName', { value: site.bucket.bucketName });
  }

  private index(
    name: string,
    projectionType: dynamodb.ProjectionType,
  ): dynamodb.GlobalSecondaryIndexPropsV2 {
    return {
      indexName: name,
      partitionKey: { name: `${name}PK`, type: dynamodb.AttributeType.STRING },
      sortKey: { name: `${name}SK`, type: dynamodb.AttributeType.STRING },
      projectionType,
      nonKeyAttributes:
        projectionType === dynamodb.ProjectionType.INCLUDE ? FEED_ATTRIBUTES : undefined,
    };
  }

  private logGroup(id: string): logs.LogGroup {
    return new logs.LogGroup(this, id, {
      retention: logs.RetentionDays.ONE_DAY,
      removalPolicy: RemovalPolicy.DESTROY,
    });
  }

  private lambdaFunction(
    id: string,
    entry: string,
    environment: Record<string, string> = {},
  ): NodejsFunction {
    return new NodejsFunction(this, id, {
      entry: backendPath(entry),
      depsLockFilePath: backendPath('package-lock.json'),
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: Duration.seconds(10),
      environment: { TABLE_NAME: this.table.tableName, LOG_LEVEL: 'INFO', ...environment },
      bundling: { format: OutputFormat.ESM, minify: true },
      logGroup: this.logGroup(`${id}Logs`),
    });
  }

  private site() {
    const bucket = new s3.Bucket(this, 'SiteBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
    const spaFallback = (httpStatus: number): cloudfront.ErrorResponse => ({
      httpStatus,
      responseHttpStatus: 200,
      responsePagePath: '/index.html',
      ttl: Duration.seconds(0),
    });
    const distribution = new cloudfront.Distribution(this, 'SiteDistribution', {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      },
      defaultRootObject: 'index.html',
      errorResponses: [spaFallback(403), spaFallback(404)],
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
    });
    return { bucket, distribution };
  }

  private reminders(senderEmail: string, siteOrigin: string): sqs.Queue {
    const deadLetters = new sqs.Queue(this, 'ReminderDeadLetters', {
      retentionPeriod: Duration.days(4),
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const queue = new sqs.Queue(this, 'ReminderQueue', {
      visibilityTimeout: Duration.seconds(60),
      deadLetterQueue: { queue: deadLetters, maxReceiveCount: 3 },
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const schedulerFunction = this.lambdaFunction(
      'ReminderScheduler',
      'src/reminders/scheduler.ts',
      {
        QUEUE_URL: queue.queueUrl,
      },
    );
    schedulerFunction.configureAsyncInvoke({ retryAttempts: 0 });
    this.table.grantReadWriteData(schedulerFunction);
    queue.grantSendMessages(schedulerFunction);

    const senderFunction = this.lambdaFunction('ReminderSender', 'src/email/sender.ts', {
      SENDER_EMAIL: senderEmail,
      SITE_URL: siteOrigin,
    });
    const senderDomain = senderEmail.replace(/^.*@/, '').replace(/>.*$/, '');
    senderFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ses:SendEmail'],
        resources: [`arn:aws:ses:${this.region}:${this.account}:identity/${senderDomain}`],
      }),
    );
    senderFunction.addEventSource(
      new SqsEventSource(queue, { batchSize: 10, reportBatchItemFailures: true }),
    );

    this.schedule('ReminderSchedule', 'cron(0/15 * * * ? *)', schedulerFunction);
    new CfnOutput(this, 'ReminderSchedulerName', { value: schedulerFunction.functionName });
    new CfnOutput(this, 'ReminderSenderLogGroup', { value: senderFunction.logGroup.logGroupName });
    return queue;
  }

  private streaksAndDigest(emailQueue: sqs.Queue): void {
    const statsFunction = this.lambdaFunction('StatsFunction', 'src/stats/handler.ts');
    this.table.grantReadWriteData(statsFunction);
    statsFunction.addEventSource(
      new DynamoEventSource(this.table, {
        startingPosition: lambda.StartingPosition.LATEST,
        batchSize: 25,
        retryAttempts: 2,
        bisectBatchOnError: true,
        reportBatchItemFailures: true,
        filters: [
          lambda.FilterCriteria.filter({
            eventName: lambda.FilterRule.isEqual('INSERT'),
            dynamodb: { NewImage: { GSI1PK: { S: lambda.FilterRule.exists() } } },
          }),
        ],
      }),
    );

    const digestFunction = this.lambdaFunction('DigestFunction', 'src/digest/handler.ts', {
      QUEUE_URL: emailQueue.queueUrl,
    });
    digestFunction.configureAsyncInvoke({ retryAttempts: 0 });
    this.table.grantReadData(digestFunction);
    emailQueue.grantSendMessages(digestFunction);
    this.schedule('DigestSchedule', 'cron(0 8 ? * MON *)', digestFunction);
    new CfnOutput(this, 'DigestFunctionName', { value: digestFunction.functionName });
  }

  private schedule(id: string, expression: string, target: lambda.IFunction): void {
    const role = new iam.Role(this, `${id}Role`, {
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com'),
    });
    target.grantInvoke(role);
    new scheduler.CfnSchedule(this, id, {
      scheduleExpression: expression,
      scheduleExpressionTimezone: 'UTC',
      flexibleTimeWindow: { mode: 'OFF' },
      target: {
        arn: target.functionArn,
        roleArn: role.roleArn,
        input: JSON.stringify({ scheduledTime: '<aws.scheduler.scheduled-time>' }),
        retryPolicy: { maximumRetryAttempts: 0 },
      },
    });
  }

  private budget(id: string, amount: number, alertEmail: string): void {
    new budgets.CfnBudget(this, id, {
      budget: {
        budgetType: 'COST',
        timeUnit: 'MONTHLY',
        budgetLimit: { amount, unit: 'USD' },
        costFilters: { TagKeyValue: ['user:project$standuplog'] },
      },
      notificationsWithSubscribers: [
        {
          notification: {
            notificationType: 'ACTUAL',
            comparisonOperator: 'GREATER_THAN',
            threshold: 100,
            thresholdType: 'PERCENTAGE',
          },
          subscribers: [{ subscriptionType: 'EMAIL', address: alertEmail }],
        },
      ],
    });
  }
}
