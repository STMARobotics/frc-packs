// Same version in each producer repository; no cross-checkout runtime dependency.
import {
  Duration,
  Stack,
  aws_dynamodb as ddb,
  aws_iam as iam,
  aws_lambda as lambda,
  aws_pipes as pipes,
  aws_sqs as sqs,
  aws_cloudwatch as cw,
} from 'aws-cdk-lib';
import { Construct } from 'constructs';
export type ActivityIntegration = {
  orgId: string;
  busArn: string;
  captureEnabled?: boolean;
  pipeEnabled?: boolean;
};
export function integrationSettings(scope: Construct): ActivityIntegration | undefined {
  const value = scope.node.tryGetContext('activityIntegration');
  if (value === undefined) return undefined;
  if (
    !value ||
    typeof value !== 'object' ||
    typeof value.orgId !== 'string' ||
    !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value.orgId ?? '') ||
    typeof value.busArn !== 'string'
  )
    throw new Error('activityIntegration needs an orgId and busArn.');
  const stack = Stack.of(scope);
  const match = /^arn:aws:events:([^:]+):(\d{12}):event-bus\/([A-Za-z0-9_.-]+)$/.exec(value.busArn);
  if (!match || match[1] !== stack.region || match[2] !== stack.account)
    throw new Error('Activity bus must be an explicit same-account, same-region Classic bus ARN.');
  for (const flag of ['captureEnabled', 'pipeEnabled'])
    if (value[flag] !== undefined && typeof value[flag] !== 'boolean')
      throw new Error(flag + ' must be a boolean.');
  if (value.captureEnabled && !value.pipeEnabled)
    throw new Error('Start the delivery pipe before enabling activity capture.');
  return value;
}
export function activityOutboxPrefixes(
  scope: Construct,
  source: 'puncher' | 'packs' | 'fmea',
): string[] {
  const settings = integrationSettings(scope);
  return settings ? ['OUTBOX#' + settings.orgId + '#' + source + '#*'] : [];
}
export function activityStream(scope: Construct): ddb.StreamViewType | undefined {
  return integrationSettings(scope) ? ddb.StreamViewType.NEW_IMAGE : undefined;
}
export const activityInputTemplate =
  '{"encoding":"activity-snapshot.v1","orgId":"<$.dynamodb.NewImage.orgId.S>","activity":{"schemaVersion":1,"eventId":"<$.dynamodb.NewImage.eventId.S>","type":"<$.dynamodb.NewImage.eventType.S>","source":"<$.dynamodb.NewImage.source.S>","orgId":"<$.dynamodb.NewImage.orgId.S>","entityId":"<$.dynamodb.NewImage.entityId.S>","entityVersion":"<$.dynamodb.NewImage.entityVersion.N>","subject":{"namespace":"<$.dynamodb.NewImage.subjectNamespace.S>","id":"<$.dynamodb.NewImage.subjectId.S>"},"occurredAt":"<$.dynamodb.NewImage.occurredAt.S>","effectiveDate":"<$.dynamodb.NewImage.effectiveDate.S>","metrics":{"shopSeconds":"<$.dynamodb.NewImage.shopSeconds.N>","volunteerSeconds":"<$.dynamodb.NewImage.volunteerSeconds.N>","packsOpened":"<$.dynamodb.NewImage.packsOpened.N>","battleWins":"<$.dynamodb.NewImage.battleWins.N>","battleLosses":"<$.dynamodb.NewImage.battleLosses.N>","battleDraws":"<$.dynamodb.NewImage.battleDraws.N>","fmeaSubmitted":"<$.dynamodb.NewImage.fmeaSubmitted.N>"}}}';
export function configureActivityPublisher(
  scope: Construct,
  table: ddb.Table,
  functions: lambda.Function[],
  source: 'puncher' | 'packs' | 'fmea',
): pipes.CfnPipe | undefined {
  const settings = integrationSettings(scope);
  if (!settings) return undefined;
  for (const fn of functions) {
    fn.addEnvironment('INTEGRATION_ENABLED', settings.captureEnabled === true ? 'true' : 'false');
    fn.addEnvironment('INTEGRATION_ORG_ID', settings.orgId);
  }
  if (!table.tableStreamArn)
    throw new Error('Enable the activity outbox stream before creating its pipe.');
  const dead = new sqs.Queue(scope, 'ActivityPublishFailures', {
    encryption: sqs.QueueEncryption.SQS_MANAGED,
    enforceSSL: true,
    retentionPeriod: Duration.days(14),
  });
  const role = new iam.Role(scope, 'ActivityPublisherRole', {
    assumedBy: new iam.ServicePrincipal('pipes.amazonaws.com', {
      conditions: { StringEquals: { 'aws:SourceAccount': Stack.of(scope).account } },
    }),
  });
  table.grantStreamRead(role);
  dead.grantSendMessages(role);
  role.addToPolicy(
    new iam.PolicyStatement({
      actions: ['events:PutEvents'],
      resources: [settings.busArn],
      conditions: { StringEquals: { 'events:source': 'org.apps.' + source } },
    }),
  );
  const pipe = new pipes.CfnPipe(scope, 'ActivityPublisher', {
    roleArn: role.roleArn,
    source: table.tableStreamArn,
    target: settings.busArn,
    desiredState: settings.pipeEnabled === true ? 'RUNNING' : 'STOPPED',
    sourceParameters: {
      filterCriteria: {
        filters: [
          {
            pattern: JSON.stringify({
              eventName: ['INSERT'],
              dynamodb: {
                NewImage: {
                  recordType: { S: ['ACTIVITY_OUTBOX_V1'] },
                  source: { S: [source] },
                  orgId: { S: [settings.orgId] },
                },
              },
            }),
          },
        ],
      },
      dynamoDbStreamParameters: {
        startingPosition: 'TRIM_HORIZON',
        batchSize: 10,
        maximumBatchingWindowInSeconds: 1,
        maximumRecordAgeInSeconds: 82800,
        maximumRetryAttempts: 10000,
        onPartialBatchItemFailure: 'AUTOMATIC_BISECT',
        deadLetterConfig: { arn: dead.queueArn },
      },
    },
    targetParameters: {
      inputTemplate: activityInputTemplate,
      eventBridgeEventBusParameters: {
        source: 'org.apps.' + source,
        detailType: '$.dynamodb.NewImage.eventType.S',
      },
    },
  });
  // Make grants available before the service validates/starts the pipe.
  pipe.node.addDependency(role);
  new cw.Alarm(scope, 'ActivityPublishDeadLetters', {
    metric: dead.metricApproximateNumberOfMessagesVisible(),
    threshold: 1,
    evaluationPeriods: 1,
    treatMissingData: cw.TreatMissingData.NOT_BREACHING,
  });
  new cw.Alarm(scope, 'ActivityPublishErrors', {
    metric: new cw.Metric({
      namespace: 'AWS/Pipes',
      metricName: 'ExecutionFailed',
      dimensionsMap: { PipeName: pipe.ref },
      period: Duration.minutes(5),
      statistic: 'Sum',
    }),
    threshold: 1,
    evaluationPeriods: 1,
    treatMissingData: cw.TreatMissingData.NOT_BREACHING,
  });
  return pipe;
}
