import * as cdk from 'aws-cdk-lib/core';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import { Construct } from 'constructs';

export class ApplyfyAwsBackendStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const helloFn = new NodejsFunction(this, 'HelloFunction', {
      entry: 'lambda/hello.ts',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_24_X,
    });

    // Access logs (custom destination)
    const apiAccessLogGroup = new logs.LogGroup(this, 'ApiAccessLogGroup', {
      logGroupName: '/aws/apigateway/ApplyfyHelloApi/prod',
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const api = new apigateway.RestApi(this, 'HelloApi', {
      restApiName: 'Hello Service',
      description: 'API Gateway exposing the hello Lambda',
      cloudWatchRole: true,
      cloudWatchRoleRemovalPolicy: cdk.RemovalPolicy.DESTROY,
      deployOptions: {
        stageName: 'prod',
        loggingLevel: apigateway.MethodLoggingLevel.INFO,
        dataTraceEnabled: true,
        metricsEnabled: true,
        accessLogDestination: new apigateway.LogGroupLogDestination(apiAccessLogGroup),
        accessLogFormat: apigateway.AccessLogFormat.jsonWithStandardFields({
          caller: true,
          httpMethod: true,
          ip: true,
          protocol: true,
          requestTime: true,
          resourcePath: true,
          responseLength: true,
          status: true,
          user: true,
        }),
      },
    });
    const hello = api.root.addResource('hello');
    hello.addMethod('GET', new apigateway.LambdaIntegration(helloFn));

    new cdk.CfnOutput(this, 'HelloUrl', {
      value: `${api.url}hello`,
      description: 'URL for the GET /hello endpoint',
    });

    new cdk.CfnOutput(this, 'ApiAccessLogGroupName', {
      value: apiAccessLogGroup.logGroupName,
      description: 'API Gateway access log group',
    });

    new cdk.CfnOutput(this, 'ApiExecutionLogGroupName', {
      value: cdk.Fn.join('', [
        'API-Gateway-Execution-Logs_',
        api.restApiId,
        '/prod',
      ]),
      description: 'API Gateway execution log group (auto-created when INFO logging is on)',
    });

    const resumeBucket = new s3.Bucket(this, 'ResumeBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      cors: [
        {
          allowedMethods: [
            s3.HttpMethods.GET,
            s3.HttpMethods.PUT,
            s3.HttpMethods.POST,
            s3.HttpMethods.HEAD,
          ],
          allowedOrigins: ['*'],
          allowedHeaders: ['*'],
          exposedHeaders: ['ETag'],
        },
      ],
    });

    new cdk.CfnOutput(this, 'ResumeBucketName', {
      value: resumeBucket.bucketName,
      description: 'Name of the private S3 bucket for resume uploads',
    });

    const resumesTable = new dynamodb.Table(this, 'ResumesTable', {
      partitionKey: { name: 'resumeId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    new cdk.CfnOutput(this, 'ResumesTableName', {
      value: resumesTable.tableName,
      description: 'DynamoDB table for parsed resume text',
    });

    const parseResumeFn = new NodejsFunction(this, 'ParseResumeFunction', {
      entry: 'lambda/parseResume.ts',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_24_X,
      timeout: cdk.Duration.seconds(60),
      memorySize: 512,
      environment: {
        RESUMES_TABLE_NAME: resumesTable.tableName,
      },
      bundling: {
        // Keep native/pdfjs-heavy packages as real node_modules in the bundle
        nodeModules: ['mammoth', 'unpdf'],
      },
    });

    resumeBucket.grantRead(parseResumeFn);
    resumesTable.grantWriteData(parseResumeFn);
    resumeBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.LambdaDestination(parseResumeFn),
    );

    const getUploadUrlFn = new NodejsFunction(this, 'GetUploadUrlFunction', {
      entry: 'lambda/getUploadUrl.ts',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_24_X,
      environment: {
        RESUME_BUCKET_NAME: resumeBucket.bucketName,
      },
    });

    resumeBucket.grantPut(getUploadUrlFn);

    const uploadUrl = api.root.addResource('upload-url', {
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: ['GET', 'OPTIONS'],
        allowHeaders: apigateway.Cors.DEFAULT_HEADERS,
      },
    });
    uploadUrl.addMethod('GET', new apigateway.LambdaIntegration(getUploadUrlFn));

    new cdk.CfnOutput(this, 'UploadUrlEndpoint', {
      value: `${api.url}upload-url`,
      description: 'URL for the GET /upload-url endpoint (pass ?filename=...)',
    });

    // Per-IP throttle for GET /upload-url only (10 requests / rolling 1-minute window)
    const uploadUrlWebAcl = new wafv2.CfnWebACL(this, 'UploadUrlWebAcl', {
      name: 'ApplyfyUploadUrlRateLimit',
      scope: 'REGIONAL',
      defaultAction: { allow: {} },
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: 'ApplyfyUploadUrlRateLimit',
        sampledRequestsEnabled: true,
      },
      customResponseBodies: {
        UploadUrlTooManyRequests: {
          contentType: 'APPLICATION_JSON',
          content: JSON.stringify({
            error: 'Too many requests. Limit is 10 requests per minute per IP.',
          }),
        },
      },
      rules: [
        {
          name: 'UploadUrlRateLimitPerIP',
          priority: 0,
          action: {
            block: {
              customResponse: {
                responseCode: 429,
                customResponseBodyKey: 'UploadUrlTooManyRequests',
                responseHeaders: [
                  { name: 'Access-Control-Allow-Origin', value: '*' },
                  { name: 'Retry-After', value: '60' },
                ],
              },
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: 'UploadUrlRateLimitPerIP',
            sampledRequestsEnabled: true,
          },
          statement: {
            rateBasedStatement: {
              limit: 10,
              evaluationWindowSec: 60,
              aggregateKeyType: 'IP',
              scopeDownStatement: {
                byteMatchStatement: {
                  fieldToMatch: { uriPath: {} },
                  positionalConstraint: 'CONTAINS',
                  searchString: 'upload-url',
                  textTransformations: [{ priority: 0, type: 'LOWERCASE' }],
                },
              },
            },
          },
        },
      ],
    });

    new wafv2.CfnWebACLAssociation(this, 'UploadUrlWebAclAssociation', {
      resourceArn: api.deploymentStage.stageArn,
      webAclArn: uploadUrlWebAcl.attrArn,
    });

    // WAF → CloudWatch Logs (name MUST start with aws-waf-logs-)
    const wafLogGroup = new logs.LogGroup(this, 'WafLogGroup', {
      logGroupName: 'aws-waf-logs-applyfy-upload-url',
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const wafLogPolicy = new logs.CfnResourcePolicy(this, 'WafLogResourcePolicy', {
      policyName: 'ApplyfyWafLoggingPolicy',
      policyDocument: cdk.Stack.of(this).toJsonString({
        Version: '2012-10-17',
        Statement: [
          {
            Sid: 'AWSLogDeliveryWrite2',
            Effect: 'Allow',
            Principal: { Service: 'delivery.logs.amazonaws.com' },
            Action: ['logs:CreateLogStream', 'logs:PutLogEvents'],
            Resource: cdk.Fn.join('', [wafLogGroup.logGroupArn, ':*']),
            Condition: {
              StringEquals: {
                'aws:SourceAccount': this.account,
              },
              ArnLike: {
                'aws:SourceArn': cdk.Fn.join('', [
                  'arn:aws:logs:',
                  this.region,
                  ':',
                  this.account,
                  ':*',
                ]),
              },
            },
          },
          {
            Sid: 'AWSLogDeliveryAclCheck',
            Effect: 'Allow',
            Principal: { Service: 'delivery.logs.amazonaws.com' },
            Action: ['logs:CreateLogGroup', 'logs:DescribeLogGroups'],
            Resource: '*',
            Condition: {
              StringEquals: {
                'aws:SourceAccount': this.account,
              },
            },
          },
        ],
      }),
    });

    const wafLogging = new wafv2.CfnLoggingConfiguration(this, 'UploadUrlWafLogging', {
      resourceArn: uploadUrlWebAcl.attrArn,
      logDestinationConfigs: [wafLogGroup.logGroupArn],
    });
    wafLogging.node.addDependency(wafLogGroup);
    wafLogging.node.addDependency(wafLogPolicy);
    new cdk.CfnOutput(this, 'WafLogGroupName', {
      value: wafLogGroup.logGroupName,
      description: 'WAF log group for ApplyfyUploadUrlRateLimit',
    });
  }
}
