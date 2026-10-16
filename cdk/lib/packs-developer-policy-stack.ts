import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { PacksBackendStack } from './packs-backend-stack';
import { PacksFrontendStack } from './packs-frontend-stack';

export interface PacksDeveloperPolicyStackProps extends cdk.StackProps {
  backendStack: PacksBackendStack;
  frontendStack: PacksFrontendStack;
}

// Stack that creates a Customer Managed Policy for developers with least-privilege access to Packs AWS resources
export class PacksDeveloperPolicyStack extends cdk.Stack {
  readonly developerManagedPolicy: iam.ManagedPolicy;

  constructor(scope: Construct, id: string, props: PacksDeveloperPolicyStackProps) {
    super(scope, id, props);

    // Create a Customer Managed Policy containing the least-privilege rules
    this.developerManagedPolicy = new iam.ManagedPolicy(this, 'PacksDeveloperPermissions', {
      description: 'Least-privilege read-write policy for packs developers',
    });

    // Extract table ARN safely
    const tableArn = props.backendStack.node.findChild('Table').node.defaultChild instanceof cdk.CfnResource 
      ? (props.backendStack.node.findChild('Table') as any).tableArn 
      : undefined;

    // DynamoDB Permissions (Includes account-level ListTables for console visibility)
    if (tableArn) {
      this.developerManagedPolicy.addStatements(
        new iam.PolicyStatement({
          sid: 'DeveloperDynamoDBAccess',
          effect: iam.Effect.ALLOW,
          actions: [
            'dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem',
            'dynamodb:Query', 'dynamodb:Scan', 'dynamodb:BatchGetItem', 'dynamodb:BatchWriteItem',
            'dynamodb:TransactWriteItems', 'dynamodb:DescribeTable'
          ],
          resources: [tableArn, `${tableArn}/index/*`],
        }),
        new iam.PolicyStatement({
          sid: 'DeveloperDynamoDBList',
          effect: iam.Effect.ALLOW,
          actions: ['dynamodb:ListTables'],
          resources: ['*'],
        })
      );
    }

    // Lambda Code Updates, Invocation, & Console Listing
    this.developerManagedPolicy.addStatements(
      new iam.PolicyStatement({
        sid: 'DeveloperLambdaManagement',
        effect: iam.Effect.ALLOW,
        actions: [
          'lambda:UpdateFunctionCode', 'lambda:UpdateFunctionConfiguration',
          'lambda:GetFunction', 'lambda:GetFunctionConfiguration',
          'lambda:InvokeFunction'
        ],
        resources: [`arn:aws:lambda:${this.region}:${this.account}:function:PacksBackendStack*`],
      }),
      new iam.PolicyStatement({
        sid: 'DeveloperLambdaList',
        effect: iam.Effect.ALLOW,
        actions: ['lambda:ListFunctions'],
        resources: ['*'],
      })
    );

    // S3 Frontend Site Bucket Access
    const siteBucketName = props.frontendStack.node.tryFindChild('SiteBucket') instanceof cdk.aws_s3.Bucket
      ? (props.frontendStack.node.tryFindChild('SiteBucket') as cdk.aws_s3.Bucket).bucketName
      : '*';

    this.developerManagedPolicy.addStatements(
      new iam.PolicyStatement({
        sid: 'DeveloperS3AssetDeployment',
        effect: iam.Effect.ALLOW,
        actions: [
          's3:GetObject', 's3:PutObject', 's3:AbortMultipartUpload', 
          's3:ListBucket', 's3:DeleteObject'
        ],
        resources: [`arn:aws:s3:::${siteBucketName}`, `arn:aws:s3:::${siteBucketName}/*`],
      }),
      new iam.PolicyStatement({
        sid: 'DeveloperS3ListBuckets',
        effect: iam.Effect.ALLOW,
        actions: ['s3:ListAllMyBuckets'],
        resources: ['*'],
      })
    );

    // CloudWatch Logs & Debugging
    this.developerManagedPolicy.addStatements(new iam.PolicyStatement({
      sid: 'DeveloperCloudWatchLogs',
      effect: iam.Effect.ALLOW,
      actions: [
        'logs:GetLogEvents', 'logs:FilterLogEvents', 
        'logs:DescribeLogStreams', 'logs:DescribeLogGroups', 
        'cloudwatch:GetMetricData', 'cloudwatch:DescribeAlarms'
      ],
      resources: [
        `arn:aws:logs:${this.region}:${this.account}:log-group:PacksBackendStack*`, 
        `arn:aws:cloudwatch:${this.region}:${this.account}:alarm:*`
      ],
    }));

    // CloudFront Cache Invalidation & Inspection
    this.developerManagedPolicy.addStatements(new iam.PolicyStatement({
      sid: 'DeveloperApiAndDistributionInspection',
      effect: iam.Effect.ALLOW,
      actions: ['apigateway:GET', 'cloudfront:GetDistribution', 'cloudfront:ListDistributions', 'cloudfront:CreateInvalidation'],
      resources: ['*'],
    }));

    // Output the Policy ARN so you can easily attach it to your Identity Center Permission Set
    new cdk.CfnOutput(this, 'DeveloperManagedPolicyArn', {
      value: this.developerManagedPolicy.managedPolicyArn,
    });
  }
}