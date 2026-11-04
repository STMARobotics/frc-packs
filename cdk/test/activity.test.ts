import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { App, Stack, aws_dynamodb as ddb, aws_lambda as lambda } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import {
  activityStream,
  configureActivityPublisher,
  activityInputTemplate,
} from '../lib/activity-publisher';

const app = new App({
  context: {
    activityIntegration: {
      orgId: 'example-team',
      busArn: 'arn:aws:events:us-east-2:111111111111:event-bus/activity',
      pipeEnabled: true,
      captureEnabled: true,
    },
  },
});
const stack = new Stack(app, 'activity-test', {
  env: { account: '111111111111', region: 'us-east-2' },
});
const table = new ddb.Table(stack, 'Table', {
  partitionKey: { name: 'pk', type: ddb.AttributeType.STRING },
  stream: activityStream(stack),
});
const fn = new lambda.Function(stack, 'Writer', {
  runtime: lambda.Runtime.NODEJS_24_X,
  handler: 'index.handler',
  code: lambda.Code.fromInline('exports.handler=async()=>{}'),
});
configureActivityPublisher(stack, table, [fn], 'packs');
const template = Template.fromStack(stack);
template.hasResourceProperties('AWS::Pipes::Pipe', {
  DesiredState: 'RUNNING',
  TargetParameters: {
    EventBridgeEventBusParameters: {
      Source: 'org.apps.packs',
      DetailType: '$.dynamodb.NewImage.eventType.S',
    },
  },
});
template.hasResourceProperties('AWS::Lambda::Function', {
  Environment: { Variables: { INTEGRATION_ENABLED: 'true', INTEGRATION_ORG_ID: 'example-team' } },
});
const resources = template.toJSON().Resources as Record<string, any>;
const pipe = Object.values(resources).find((r) => r.Type === 'AWS::Pipes::Pipe');
assert.deepEqual(
  JSON.parse(pipe.Properties.SourceParameters.FilterCriteria.Filters[0].Pattern).eventName,
  ['INSERT'],
);
assert.ok(activityInputTemplate.includes('packsOpened'));
const fixtures = JSON.parse(
  readFileSync('../contracts/fixtures/activity-v1.json', 'utf8'),
) as any[];
assert.equal(fixtures.filter((e) => e.source === 'packs').length, 2);
const disabled = new Stack(new App(), 'disabled', {
  env: { account: '111111111111', region: 'us-east-2' },
});
assert.equal(activityStream(disabled), undefined);
console.log('Packs activity infrastructure assertions passed.');
