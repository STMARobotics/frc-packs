import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as cdk from "aws-cdk-lib";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import { Template } from "aws-cdk-lib/assertions";
import { config, contentSecurityPolicy, fqdn } from "../lib/config";
import { PacksBackendStack } from "../lib/packs-backend-stack";
import { PacksCertificateStack } from "../lib/packs-certificate-stack";
import { PacksFrontendStack } from "../lib/packs-frontend-stack";

const app = new cdk.App();
const certificateStack = new PacksCertificateStack(app, config.stackNames.certificate, {
  env: { account: "111111111111", region: config.regions.certificate },
  crossRegionReferences: true,
});
const backendStack = new PacksBackendStack(app, config.stackNames.backend, {
  env: { account: "111111111111", region: config.regions.application },
});
const frontendStack = new PacksFrontendStack(app, config.stackNames.frontend, {
  env: { account: "111111111111", region: config.regions.application },
  crossRegionReferences: true,
  certificate: certificateStack.certificate,
  api: backendStack.api,
});

assert.equal(certificateStack.stackName, "packs-certificate");
assert.equal(certificateStack.region, "us-east-1");
assert.equal(backendStack.stackName, "packs-backend");
assert.equal(backendStack.region, "us-east-2");
assert.equal(frontendStack.stackName, "packs-frontend");
assert.equal(frontendStack.region, "us-east-2");

const certificateTemplate = Template.fromStack(certificateStack);
certificateTemplate.resourceCountIs("AWS::CertificateManager::Certificate", 1);
certificateTemplate.resourceCountIs("AWS::Route53::RecordSet", 0);
certificateTemplate.hasResourceProperties("AWS::CertificateManager::Certificate", {
  DomainName: fqdn,
  ValidationMethod: "DNS",
});

const backendTemplate = Template.fromStack(backendStack);
backendTemplate.resourceCountIs("AWS::ApiGatewayV2::Api", 1);
backendTemplate.resourceCountIs("AWS::ApiGatewayV2::Route", 2);
backendTemplate.resourceCountIs("AWS::DynamoDB::Table", 1);
backendTemplate.resourceCountIs("AWS::RDS::DBInstance", 0);
backendTemplate.resourceCountIs("AWS::RDS::DBCluster", 0);
backendTemplate.resourceCountIs("AWS::EC2::VPC", 0);
backendTemplate.resourceCountIs("AWS::Lambda::Function", 2);
// A schedule runs the "free pack ready" check; alarms and the budget only exist once an alert email is configured.
backendTemplate.resourceCountIs("AWS::Events::Rule", 1);
backendTemplate.hasResourceProperties("AWS::Events::Rule", {
  ScheduleExpression: `rate(${config.readyCheckMinutes} minutes)`,
});
backendTemplate.resourceCountIs("AWS::CloudWatch::Alarm", config.alertEmail ? 4 : 0);
backendTemplate.resourceCountIs("AWS::Budgets::Budget", config.alertEmail ? 1 : 0);
backendTemplate.resourceCountIs("AWS::SecretsManager::Secret", 0);
backendTemplate.hasResourceProperties("AWS::ApiGatewayV2::Stage", {
  DefaultRouteSettings: {
    ThrottlingRateLimit: config.apiThrottle.rate,
    ThrottlingBurstLimit: config.apiThrottle.burst,
  },
});
const backendResources = backendTemplate.toJSON().Resources as Record<string, { Type: string; Properties?: Record<string, unknown> }>;
const lambdas = Object.values(backendResources).filter((resource) =>
  resource.Type === "AWS::Lambda::Function" && resource.Properties?.Runtime === "provided.al2023");
const readyCheckFn = lambdas.find((fn) => (fn.Properties?.Environment as { Variables: Record<string, unknown> }).Variables.LAMBDA_TASK === "ready-check");
assert.ok(readyCheckFn, "the scheduled free-pack check runs as its own function");
const server = lambdas.find((fn) => fn !== readyCheckFn);
assert.ok(server);
assert.deepEqual(server.Properties?.Architectures, ["arm64"]);
const environment = (server.Properties?.Environment as { Variables: Record<string, unknown> }).Variables;
assert.equal(environment.COOKIE_SECURE, "1");
assert.equal(environment.DATA_DIR, "/var/task/data");
assert.deepEqual(environment.TABLE_NAME, { Ref: backendTemplate.getResourceId("AWS::DynamoDB::Table") });
assert.equal(environment.ADMIN_ONLY, "0");
assert.equal("DATABASE_URL" in environment, false);
assert.equal("ORIGIN_SECRET" in environment, false);
assert.equal("LAMBDA_TASK" in environment, false);
backendTemplate.hasResourceProperties("AWS::DynamoDB::Table", {
  BillingMode: "PAY_PER_REQUEST",
  KeySchema: [
    { AttributeName: "pk", KeyType: "HASH" },
    { AttributeName: "sk", KeyType: "RANGE" },
  ],
  GlobalSecondaryIndexes: [
    {
      IndexName: "gsi1",
      KeySchema: [
        { AttributeName: "gsi1pk", KeyType: "HASH" },
        { AttributeName: "gsi1sk", KeyType: "RANGE" },
      ],
      Projection: { ProjectionType: "ALL" },
    },
    {
      IndexName: "gsi2",
      KeySchema: [
        { AttributeName: "gsi2pk", KeyType: "HASH" },
        { AttributeName: "gsi2sk", KeyType: "RANGE" },
      ],
      Projection: { ProjectionType: "ALL" },
    },
  ],
  TimeToLiveSpecification: { AttributeName: "expires_at", Enabled: true },
  PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
});
const tableResource = Object.values(backendTemplate.toJSON().Resources as Record<string, { Type: string; DeletionPolicy?: string; UpdateReplacePolicy?: string }>)
  .find(({ Type }) => Type === "AWS::DynamoDB::Table");
assert.equal(tableResource?.DeletionPolicy, "Retain");
assert.equal(tableResource?.UpdateReplacePolicy, "Retain");
backendTemplate.hasResourceProperties("AWS::DynamoDB::Table", { DeletionProtectionEnabled: true });
assert.match(JSON.stringify(backendResources), /dynamodb:TransactWriteItems/);
assert.match(JSON.stringify(backendResources), /dynamodb:DescribeTable/);

const frontendTemplate = Template.fromStack(frontendStack);
frontendTemplate.resourceCountIs("AWS::S3::Bucket", 1);
frontendTemplate.resourceCountIs("AWS::CloudFront::Distribution", 1);
frontendTemplate.resourceCountIs("AWS::CloudFront::Function", 1);
frontendTemplate.resourceCountIs("AWS::Route53::RecordSet", config.hostedZoneId ? 1 : 0);
const frontendResources = frontendTemplate.toJSON().Resources as Record<
  string,
  { Type: string; Properties?: Record<string, unknown>; DependsOn?: string | string[] }
>;
const distribution = Object.values(frontendResources).find((resource) => resource.Type === "AWS::CloudFront::Distribution");
assert.ok(distribution);
const distributionConfig = distribution.Properties?.DistributionConfig as {
  Aliases: string[];
  ViewerCertificate: { AcmCertificateArn: unknown };
  DefaultCacheBehavior: {
    FunctionAssociations: Array<{ EventType: string }>;
    CachePolicyId: string;
  };
  CacheBehaviors: Array<{
    PathPattern: string;
    AllowedMethods?: string[];
    CachePolicyId: string;
    OriginRequestPolicyId?: string;
  }>;
};
assert.deepEqual(distributionConfig.Aliases, [fqdn]);
assert.ok(distributionConfig.ViewerCertificate.AcmCertificateArn);
assert.equal(distributionConfig.DefaultCacheBehavior.CachePolicyId, cloudfront.CachePolicy.CACHING_OPTIMIZED.cachePolicyId);
assert.ok(distributionConfig.DefaultCacheBehavior.FunctionAssociations.some(({ EventType }) => EventType === "viewer-request"));
for (const pathPattern of ["/api", "/api/*"]) {
  const behavior = distributionConfig.CacheBehaviors.find((candidate) => candidate.PathPattern === pathPattern);
  assert.ok(behavior);
  assert.ok(behavior.AllowedMethods?.includes("POST"));
  assert.equal(behavior.CachePolicyId, cloudfront.CachePolicy.CACHING_DISABLED.cachePolicyId);
  assert.ok(behavior.OriginRequestPolicyId);
  assert.notEqual(behavior.OriginRequestPolicyId, cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER.originRequestPolicyId);
}
// The API must see the visitor's address (for sign-in limits) and the idempotency key, but not the browser's Host.
frontendTemplate.hasResourceProperties("AWS::CloudFront::OriginRequestPolicy", {
  OriginRequestPolicyConfig: {
    HeadersConfig: {
      HeaderBehavior: "whitelist",
      Headers: ["CloudFront-Viewer-Address", "Idempotency-Key", "Accept"],
    },
    CookiesConfig: { CookieBehavior: "all" },
  },
});
// Every behavior sends the security headers.
const securityHeadersId = Object.entries(frontendResources).find(([, r]) => r.Type === "AWS::CloudFront::ResponseHeadersPolicy")?.[0];
assert.ok(securityHeadersId);
for (const behavior of [distributionConfig.DefaultCacheBehavior, ...distributionConfig.CacheBehaviors]) {
  assert.deepEqual((behavior as { ResponseHeadersPolicyId?: unknown }).ResponseHeadersPolicyId, { Ref: securityHeadersId });
}
frontendTemplate.hasResourceProperties("AWS::CloudFront::ResponseHeadersPolicy", {
  ResponseHeadersPolicyConfig: {
    SecurityHeadersConfig: {
      ContentSecurityPolicy: { ContentSecurityPolicy: contentSecurityPolicy, Override: true },
      FrameOptions: { FrameOption: "DENY", Override: true },
      ContentTypeOptions: { Override: true },
    },
  },
});
assert.doesNotMatch(JSON.stringify(distribution.Properties), /X-Origin-Secret/);
// The server sends the same CSP for pages it serves itself; the two must not drift apart.
const serverSource = fs.readFileSync(path.resolve(__dirname, "../../server/src/lib.rs"), "utf8");
const rustBlock = /CONTENT_SECURITY_POLICY: &str = concat!\(([^)]*)\);/.exec(serverSource)?.[1];
assert.ok(rustBlock, "found the CSP in server/src/lib.rs");
assert.equal([...rustBlock.matchAll(/"([^"]*)"/g)].map((m) => m[1]).join(""), contentSecurityPolicy);
for (const pathPattern of ["/assets/*", "/photos/*"]) {
  const behavior = distributionConfig.CacheBehaviors.find((candidate) => candidate.PathPattern === pathPattern);
  assert.equal(behavior?.CachePolicyId, cloudfront.CachePolicy.CACHING_OPTIMIZED.cachePolicyId);
}
const packsBehavior = distributionConfig.CacheBehaviors.find(({ PathPattern }) => PathPattern === "/packs/*");
assert.ok(packsBehavior);
const packsCachePolicyEntry = Object.entries(frontendResources).find(([, resource]) => {
  const cachePolicyConfig = resource.Properties?.CachePolicyConfig as { MaxTTL?: number } | undefined;
  return resource.Type === "AWS::CloudFront::CachePolicy" && cachePolicyConfig?.MaxTTL === 14400;
});
const packsCachePolicy = packsCachePolicyEntry?.[1];
assert.ok(packsCachePolicy);
const packsCachePolicyConfig = (packsCachePolicy.Properties as {
  CachePolicyConfig: { MinTTL: number; DefaultTTL: number; MaxTTL: number };
}).CachePolicyConfig;
assert.equal(packsCachePolicyConfig.MinTTL, 0);
assert.equal(packsCachePolicyConfig.DefaultTTL, 14400);
assert.equal(packsCachePolicyConfig.MaxTTL, 14400);
assert.deepEqual(packsBehavior.CachePolicyId, { Ref: packsCachePolicyEntry?.[0] });

const deployments = Object.entries(frontendResources).filter(([, resource]) => resource.Type === "Custom::CDKBucketDeployment");
const siteDeploymentEntry = deployments.find(([, resource]) => JSON.stringify(resource.Properties).includes("s-maxage=86400"));
const siteDeployment = siteDeploymentEntry?.[1];
assert.ok(siteDeployment);
assert.match(JSON.stringify(siteDeployment.Properties), /DistributionId/);
assert.match(JSON.stringify(siteDeployment.Properties), /\/\*/);
assert.deepEqual(siteDeployment.Properties?.DistributionPaths, ["/*"]);
const siteDependencies = Array.isArray(siteDeployment.DependsOn) ? siteDeployment.DependsOn : [siteDeployment.DependsOn];
for (const cacheControl of [
  "max-age=31536000, immutable",
  "max-age=86400",
  "max-age=14400",
]) {
  const deployment = deployments.find(([, resource]) => JSON.stringify(resource.Properties).includes(cacheControl));
  assert.ok(deployment, `Missing deployment with Cache-Control ${cacheControl}`);
  assert.ok(siteDependencies.includes(deployment[0]), `Site invalidation must wait for ${deployment[0]}`);
}
const packsDeployment = deployments.find(([, resource]) => JSON.stringify(resource.Properties).includes("max-age=14400"));
assert.ok(packsDeployment);

console.log("CDK stack synthesis checks passed.");
