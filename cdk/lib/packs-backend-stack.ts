import * as path from "node:path";
import * as apigatewayv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as budgets from "aws-cdk-lib/aws-budgets";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cloudwatchActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as events from "aws-cdk-lib/aws-events";
import * as eventTargets from "aws-cdk-lib/aws-events-targets";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as sns from "aws-cdk-lib/aws-sns";
import * as subscriptions from "aws-cdk-lib/aws-sns-subscriptions";
import * as integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import { config } from "./config";

const BUILD_DIR = path.resolve(__dirname, "../.build");

export interface PacksBackendStackProps extends cdk.StackProps {}

export class PacksBackendStack extends cdk.Stack {
  readonly api: apigatewayv2.HttpApi;
  /** Shared with CloudFront, which sends it to the API; the server refuses requests without it. */
  readonly originSecret: secretsmanager.Secret;

  constructor(scope: Construct, id: string, props: PacksBackendStackProps) {
    super(scope, id, props);

    const table = new dynamodb.Table(this, "Table", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      timeToLiveAttribute: "expires_at",
      deletionProtection: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    table.addGlobalSecondaryIndex({
      indexName: "gsi1",
      partitionKey: { name: "gsi1pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "gsi1sk", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });
    table.addGlobalSecondaryIndex({
      indexName: "gsi2",
      partitionKey: { name: "gsi2pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "gsi2sk", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    this.originSecret = new secretsmanager.Secret(this, "OriginSecret", {
      description: "Sent by CloudFront to the API in X-Origin-Secret; the server refuses requests without it.",
      generateSecretString: { excludePunctuation: true, passwordLength: 40 },
    });
    const originSecret = this.originSecret.secretValue.unsafeUnwrap();
    const code = lambda.Code.fromAsset(path.join(BUILD_DIR, "lambda"));

    const server = new lambda.Function(this, "ServerFunction", {
      runtime: lambda.Runtime.PROVIDED_AL2023,
      architecture: lambda.Architecture.ARM_64,
      handler: "bootstrap",
      code,
      memorySize: config.lambda.memorySize,
      timeout: cdk.Duration.seconds(config.lambda.timeoutSeconds),
      environment: {
        COOKIE_SECURE: "1",
        DATA_DIR: "/var/task/data",
        TABLE_NAME: table.tableName,
        ADMIN_ONLY: config.lambda.adminOnly ? "1" : "0",
        ORIGIN_SECRET: originSecret,
      },
      logGroup: new logs.LogGroup(this, "ServerLogs", {
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
      }),
    });
    table.grantReadWriteData(server);
    table.grant(server, "dynamodb:DescribeTable", "dynamodb:TransactWriteItems");

    // The same program on a timer: tells players whose free pack is ready (Lambda only runs when called, so the
    // server's own once-a-minute loop can't do it).
    const readyCheck = new lambda.Function(this, "ReadyCheckFunction", {
      runtime: lambda.Runtime.PROVIDED_AL2023,
      architecture: lambda.Architecture.ARM_64,
      handler: "bootstrap",
      code,
      memorySize: 256,
      timeout: cdk.Duration.minutes(5),
      environment: {
        LAMBDA_TASK: "ready-check",
        DATA_DIR: "/var/task/data",
        TABLE_NAME: table.tableName,
      },
      logGroup: new logs.LogGroup(this, "ReadyCheckLogs", {
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
      }),
    });
    table.grantReadWriteData(readyCheck);
    table.grant(readyCheck, "dynamodb:DescribeTable", "dynamodb:TransactWriteItems");
    new events.Rule(this, "ReadyCheckSchedule", {
      schedule: events.Schedule.rate(cdk.Duration.minutes(config.readyCheckMinutes)),
      targets: [new eventTargets.LambdaFunction(readyCheck, { retryAttempts: 0 })],
    });

    this.api = new apigatewayv2.HttpApi(this, "HttpApi", {
      description: "FRC Packs Rust API",
      createDefaultStage: true,
    });
    const integration = new integrations.HttpLambdaIntegration("ServerIntegration", server);
    this.api.addRoutes({ path: "/api", methods: [apigatewayv2.HttpMethod.ANY], integration });
    this.api.addRoutes({ path: "/api/{proxy+}", methods: [apigatewayv2.HttpMethod.ANY], integration });

    // Slow down floods before they reach the Lambda (and the bill).
    const stage = this.api.defaultStage?.node.defaultChild as apigatewayv2.CfnStage;
    stage.defaultRouteSettings = {
      throttlingRateLimit: config.apiThrottle.rate,
      throttlingBurstLimit: config.apiThrottle.burst,
    };

    if (config.alertEmail) {
      const alerts = new sns.Topic(this, "Alerts");
      alerts.addSubscription(new subscriptions.EmailSubscription(config.alertEmail));
      const fiveMinutes = cdk.Duration.minutes(5);
      const alarm = (id: string, metric: cloudwatch.IMetric, description: string) =>
        new cloudwatch.Alarm(this, id, {
          metric,
          threshold: 5,
          evaluationPeriods: 1,
          comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
          treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
          alarmDescription: description,
        }).addAlarmAction(new cloudwatchActions.SnsAction(alerts));
      alarm("ServerErrors", server.metricErrors({ period: fiveMinutes }), "The API function failed 5 or more times in 5 minutes");
      alarm("ServerThrottles", server.metricThrottles({ period: fiveMinutes }), "The API function was throttled 5 or more times in 5 minutes");
      alarm(
        "ApiServerErrors",
        new cloudwatch.Metric({
          namespace: "AWS/ApiGateway",
          metricName: "5xx",
          dimensionsMap: { ApiId: this.api.apiId },
          statistic: "Sum",
          period: fiveMinutes,
        }),
        "The API answered with a server error 5 or more times in 5 minutes",
      );
      alarm("ReadyCheckErrors", readyCheck.metricErrors({ period: fiveMinutes }), "The free-pack notification check is failing");
      new budgets.CfnBudget(this, "MonthlyBudget", {
        budget: {
          budgetType: "COST",
          timeUnit: "MONTHLY",
          budgetLimit: { amount: config.monthlyBudgetUsd, unit: "USD" },
        },
        notificationsWithSubscribers: [80, 100].map((threshold) => ({
          notification: {
            notificationType: "ACTUAL",
            comparisonOperator: "GREATER_THAN",
            threshold,
            thresholdType: "PERCENTAGE",
          },
          subscribers: [{ subscriptionType: "EMAIL", address: config.alertEmail }],
        })),
      });
    }

    new cdk.CfnOutput(this, "ApiEndpoint", { value: this.api.apiEndpoint });
    new cdk.CfnOutput(this, "TableName", { value: table.tableName });

    new cdk.CfnOutput(this, "OriginSecretExport", {
      value: this.originSecret.secretArn,
      exportName: "packs-backend-OriginSecret",
    });
  }
}