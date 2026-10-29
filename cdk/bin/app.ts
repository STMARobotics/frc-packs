#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { config } from "../lib/config";
import { PacksBackendStack } from "../lib/packs-backend-stack";
import { PacksCertificateStack } from "../lib/packs-certificate-stack";
import { PacksFrontendStack } from "../lib/packs-frontend-stack";
import { PacksDeveloperPolicyStack } from "../lib/packs-developer-policy-stack";

const app = new cdk.App();
cdk.Tags.of(app).add("AppName", "Packs");

const certificate = new PacksCertificateStack(app, config.stackNames.certificate, {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: config.regions.certificate },
  stackName: config.stackNames.certificate,
  crossRegionReferences: true,
});
const backend = new PacksBackendStack(app, config.stackNames.backend, {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: config.regions.application },
  stackName: config.stackNames.backend,
});
const frontend = new PacksFrontendStack(app, config.stackNames.frontend, {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: config.regions.application },
  stackName: config.stackNames.frontend,
  crossRegionReferences: true,
  certificate: certificate.certificate,
  api: backend.api,
});

new PacksDeveloperPolicyStack(app, `${config.stackNames.developerPolicy}`, {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: config.regions.application },
  stackName: `${config.stackNames.developerPolicy}`,
  backendStack: backend,
  frontendStack: frontend,
});