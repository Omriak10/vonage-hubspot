#!/usr/bin/env node
// One-shot AWS deployment for the Vonage Messaging for HubSpot backend.
//
//   Lambda (Node 22, arm64)  <-  API Gateway HTTP API  <-  CloudFront  <-  Route 53 alias
//   DynamoDB table for state (one item per key)
//
// Everything stays inside the AWS perpetual free tier at small volumes except the
// HTTP API after its first 12 months (about $1 per million requests).
//
// Usage:
//   node deploy/aws/setup.js            # create or update everything, then print the URLs
//   node deploy/aws/setup.js --code     # only rebuild the zip and update the function code
//
// Configuration (environment variables or deploy/aws/config.json):
//   AWS_PROFILE      AWS CLI profile to use (default: default)
//   AWS_REGION       region for Lambda, API Gateway and DynamoDB (default: eu-north-1)
//   DOMAIN           public hostname, e.g. hubspot.example.com (must live in Route 53)
//   HOSTED_ZONE_ID   Route 53 hosted zone id of that domain
//   FUNCTION_NAME    default vonage-hubspot
//   TABLE_NAME       default vonage-hubspot-state
//   ADMIN_KEY, HS_CLIENT_ID, HS_CLIENT_SECRET, HS_APP_ID, HS_SCOPES, HS_OPTIONAL_SCOPES
//                    same meaning as in vcr-backend/vcr.yml.example
//   PORTAL_AUTH      enforce (default) or log
//
// Requires: npm install in deploy/aws (AWS SDK v3 clients) and npm install in vcr-backend.
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const cfgFile = path.join(__dirname, 'config.json');
const cfg = Object.assign({}, fs.existsSync(cfgFile) ? JSON.parse(fs.readFileSync(cfgFile, 'utf8')) : {}, process.env);
const need = (k, d) => { const v = cfg[k] || d; if (!v) { console.error(`missing ${k}`); process.exit(1); } return v; };
const REGION = cfg.AWS_REGION || 'eu-north-1';
const PROFILE = cfg.AWS_PROFILE || 'default';
const DOMAIN = need('DOMAIN');
const ZONE = need('HOSTED_ZONE_ID');
const FN = cfg.FUNCTION_NAME || 'vonage-hubspot';
const TABLE = cfg.TABLE_NAME || 'vonage-hubspot-state';
const ROLE = `${FN}-lambda-role`;
const ENV = {
  BASE_URL: `https://${DOMAIN}`,
  ADMIN_KEY: need('ADMIN_KEY'),
  HS_CLIENT_ID: need('HS_CLIENT_ID'),
  HS_CLIENT_SECRET: need('HS_CLIENT_SECRET'),
  HS_APP_ID: cfg.HS_APP_ID || '',
  HS_SCOPES: cfg.HS_SCOPES || 'oauth crm.objects.contacts.read crm.objects.contacts.write crm.lists.read crm.objects.leads.read',
  HS_OPTIONAL_SCOPES: cfg.HS_OPTIONAL_SCOPES || 'conversations.read conversations.custom_channels.read conversations.custom_channels.write crm.objects.custom.read',
  STATE_BACKEND: 'dynamodb',
  STATE_TABLE: TABLE,
  PORTAL_AUTH: cfg.PORTAL_AUTH || 'enforce',
};
const codeOnly = process.argv.includes('--code');

const { fromIni } = require('@aws-sdk/credential-provider-ini');
const credentials = fromIni({ profile: PROFILE });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function buildZip() {
  const root = path.join(__dirname, '..', '..', 'vcr-backend');
  const out = path.join(__dirname, 'lambda.zip');
  if (!fs.existsSync(path.join(root, 'node_modules'))) execSync('npm install --omit=dev', { cwd: root, stdio: 'inherit' });
  // python's zipfile is available everywhere; no extra dependency for the deployer
  const py = `
import zipfile,os
root=${JSON.stringify(root)}; z=zipfile.ZipFile(${JSON.stringify(out)},'w',zipfile.ZIP_DEFLATED)
for base,dirs,files in os.walk(root):
    for f in files:
        if f in ('vcr.yml',) or f.endswith('.key') or f.startswith('_'): continue
        p=os.path.join(base,f); z.write(p, os.path.relpath(p,root))
z.close(); print('zip', round(os.path.getsize(${JSON.stringify(out)})/1e6,1), 'MB')`;
  execSync(`python -c "${py.replace(/"/g, '\\"').replace(/\n/g, ';')}"`, { stdio: 'inherit' });
  return fs.readFileSync(out);
}

(async () => {
  const { DynamoDBClient, CreateTableCommand, DescribeTableCommand } = require('@aws-sdk/client-dynamodb');
  const { IAMClient, CreateRoleCommand, GetRoleCommand, AttachRolePolicyCommand, PutRolePolicyCommand } = require('@aws-sdk/client-iam');
  const { LambdaClient, CreateFunctionCommand, GetFunctionCommand, UpdateFunctionCodeCommand, UpdateFunctionConfigurationCommand, GetFunctionConfigurationCommand, AddPermissionCommand } = require('@aws-sdk/client-lambda');
  const { ApiGatewayV2Client, CreateApiCommand, GetApisCommand } = require('@aws-sdk/client-apigatewayv2');
  const { ACMClient, RequestCertificateCommand, DescribeCertificateCommand, ListCertificatesCommand } = require('@aws-sdk/client-acm');
  const { CloudFrontClient, CreateDistributionCommand, ListDistributionsCommand } = require('@aws-sdk/client-cloudfront');
  const { Route53Client, ChangeResourceRecordSetsCommand } = require('@aws-sdk/client-route-53');

  const lambda = new LambdaClient({ region: REGION, credentials });
  const waitReady = async () => { for (let i = 0; i < 40; i++) { const c = await lambda.send(new GetFunctionConfigurationCommand({ FunctionName: FN })); if (c.State === 'Active' && c.LastUpdateStatus !== 'InProgress') return; await sleep(2000); } };
  const code = buildZip();
  let exists = true; try { await lambda.send(new GetFunctionCommand({ FunctionName: FN })); } catch { exists = false; }
  if (codeOnly && exists) {
    await lambda.send(new UpdateFunctionCodeCommand({ FunctionName: FN, ZipFile: code })); await waitReady();
    await lambda.send(new UpdateFunctionConfigurationCommand({ FunctionName: FN, Environment: { Variables: ENV } })); await waitReady();
    console.log('code + env updated'); return;
  }

  // 1. DynamoDB
  const ddb = new DynamoDBClient({ region: REGION, credentials });
  try { await ddb.send(new DescribeTableCommand({ TableName: TABLE })); }
  catch { await ddb.send(new CreateTableCommand({ TableName: TABLE, AttributeDefinitions: [{ AttributeName: 'k', AttributeType: 'S' }], KeySchema: [{ AttributeName: 'k', KeyType: 'HASH' }], BillingMode: 'PROVISIONED', ProvisionedThroughput: { ReadCapacityUnits: 10, WriteCapacityUnits: 10 } })); console.log('table created'); }

  // 2. IAM role
  const iam = new IAMClient({ region: 'us-east-1', credentials });
  let roleArn;
  try { roleArn = (await iam.send(new GetRoleCommand({ RoleName: ROLE }))).Role.Arn; }
  catch {
    roleArn = (await iam.send(new CreateRoleCommand({ RoleName: ROLE, AssumeRolePolicyDocument: JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' }, Action: 'sts:AssumeRole' }] }) }))).Role.Arn;
    await iam.send(new AttachRolePolicyCommand({ RoleName: ROLE, PolicyArn: 'arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole' }));
    console.log('role created');
  }
  await iam.send(new PutRolePolicyCommand({ RoleName: ROLE, PolicyName: 'state-table', PolicyDocument: JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:DeleteItem', 'dynamodb:Query', 'dynamodb:UpdateItem'], Resource: `arn:aws:dynamodb:${REGION}:*:table/${TABLE}` }] }) }));

  // 3. Lambda
  if (!exists) {
    for (let i = 0; i < 10; i++) {
      try { await lambda.send(new CreateFunctionCommand({ FunctionName: FN, Runtime: 'nodejs22.x', Role: roleArn, Handler: 'server.handler', Code: { ZipFile: code }, Timeout: 60, MemorySize: 512, Architectures: ['arm64'], Environment: { Variables: ENV }, Description: 'Vonage Messaging for HubSpot backend' })); console.log('function created'); break; }
      catch (e) { if (/role|assume/i.test(e.message) && i < 9) { await sleep(6000); continue; } throw e; }
    }
  } else {
    await lambda.send(new UpdateFunctionCodeCommand({ FunctionName: FN, ZipFile: code })); await waitReady();
    await lambda.send(new UpdateFunctionConfigurationCommand({ FunctionName: FN, Environment: { Variables: ENV }, Timeout: 60, MemorySize: 512 }));
    console.log('function updated');
  }
  await waitReady();
  const fnArn = (await lambda.send(new GetFunctionConfigurationCommand({ FunctionName: FN }))).FunctionArn;
  const account = fnArn.split(':')[4];

  // 4. API Gateway HTTP API (public entry; Lambda function URLs can be blocked by account policy)
  const ag = new ApiGatewayV2Client({ region: REGION, credentials });
  let api = ((await ag.send(new GetApisCommand({}))).Items || []).find((a) => a.Name === FN);
  if (!api) { api = await ag.send(new CreateApiCommand({ Name: FN, ProtocolType: 'HTTP', Target: fnArn })); console.log('api created'); }
  try { await lambda.send(new AddPermissionCommand({ FunctionName: FN, StatementId: 'apigw', Action: 'lambda:InvokeFunction', Principal: 'apigateway.amazonaws.com', SourceArn: `arn:aws:execute-api:${REGION}:${account}:${api.ApiId}/*` })); } catch (e) { if (e.name !== 'ResourceConflictException') throw e; }
  const apiHost = api.ApiEndpoint.replace('https://', '');

  // 5. Certificate (us-east-1 for CloudFront) + DNS validation
  const acm = new ACMClient({ region: 'us-east-1', credentials });
  const r53 = new Route53Client({ region: 'us-east-1', credentials });
  let cert = (await acm.send(new ListCertificatesCommand({ CertificateStatuses: ['ISSUED', 'PENDING_VALIDATION'] }))).CertificateSummaryList.find((c) => c.DomainName === DOMAIN);
  let certArn = cert && cert.CertificateArn;
  if (!certArn) certArn = (await acm.send(new RequestCertificateCommand({ DomainName: DOMAIN, ValidationMethod: 'DNS' }))).CertificateArn;
  let rr; for (let i = 0; i < 20 && !rr; i++) { const d = await acm.send(new DescribeCertificateCommand({ CertificateArn: certArn })); rr = d.Certificate.DomainValidationOptions && d.Certificate.DomainValidationOptions[0].ResourceRecord; if (!rr) await sleep(3000); }
  await r53.send(new ChangeResourceRecordSetsCommand({ HostedZoneId: ZONE, ChangeBatch: { Changes: [{ Action: 'UPSERT', ResourceRecordSet: { Name: rr.Name, Type: rr.Type, TTL: 300, ResourceRecords: [{ Value: rr.Value }] } }] } }));
  for (let i = 0; i < 90; i++) { const s = (await acm.send(new DescribeCertificateCommand({ CertificateArn: certArn }))).Certificate.Status; if (s === 'ISSUED') break; if (i === 89) throw new Error('certificate not issued in time'); await sleep(10000); }
  console.log('certificate issued');

  // 6. CloudFront (no caching, all methods, forwards everything except Host) + Route 53 alias
  const cf = new CloudFrontClient({ region: 'us-east-1', credentials });
  let dist = ((await cf.send(new ListDistributionsCommand({}))).DistributionList.Items || []).find((d) => (d.Aliases.Items || []).includes(DOMAIN));
  if (!dist) {
    dist = (await cf.send(new CreateDistributionCommand({ DistributionConfig: {
      CallerReference: `${FN}-${Date.now()}`, Comment: 'Vonage Messaging for HubSpot backend', Enabled: true, HttpVersion: 'http2and3', PriceClass: 'PriceClass_100',
      Aliases: { Quantity: 1, Items: [DOMAIN] },
      ViewerCertificate: { ACMCertificateArn: certArn, SSLSupportMethod: 'sni-only', MinimumProtocolVersion: 'TLSv1.2_2021' },
      Origins: { Quantity: 1, Items: [{ Id: 'api', DomainName: apiHost, CustomOriginConfig: { HTTPPort: 80, HTTPSPort: 443, OriginProtocolPolicy: 'https-only', OriginSslProtocols: { Quantity: 1, Items: ['TLSv1.2'] }, OriginReadTimeout: 60, OriginKeepaliveTimeout: 5 } }] },
      DefaultCacheBehavior: { TargetOriginId: 'api', ViewerProtocolPolicy: 'redirect-to-https', Compress: true, AllowedMethods: { Quantity: 7, Items: ['GET', 'HEAD', 'OPTIONS', 'PUT', 'POST', 'PATCH', 'DELETE'], CachedMethods: { Quantity: 2, Items: ['GET', 'HEAD'] } }, CachePolicyId: '4135ea2d-6df8-44a3-9df3-4b5a84be39ad', OriginRequestPolicyId: 'b689b0a8-53d0-40ab-baf2-68738e2966ac' },
    } }))).Distribution;
    console.log('distribution created');
  }
  const alias = (type) => ({ Action: 'UPSERT', ResourceRecordSet: { Name: DOMAIN, Type: type, AliasTarget: { HostedZoneId: 'Z2FDTNDATAQYW2', DNSName: dist.DomainName, EvaluateTargetHealth: false } } });
  await r53.send(new ChangeResourceRecordSetsCommand({ HostedZoneId: ZONE, ChangeBatch: { Changes: [alias('A'), alias('AAAA')] } }));
  console.log(JSON.stringify({ domain: `https://${DOMAIN}`, apiEndpoint: api.ApiEndpoint, cloudfront: dist.DomainName, function: FN, table: TABLE }, null, 2));
})().catch((e) => { console.error('ERR', e.name, e.message); process.exit(1); });
