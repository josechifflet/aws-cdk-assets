import * as cdk from 'aws-cdk-lib';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecr_assets from 'aws-cdk-lib/aws-ecr-assets';
import * as ecrdeploy from 'cdk-ecr-deployment';
import { Construct } from 'constructs';

import { config } from '../utils/config';

import path = require('path');

type ApiAssetProps = {
  vpc: ec2.Vpc;
  dbSecurityGroup: ec2.SecurityGroup;
  dbPasswordSecret: secretsmanager.Secret;
};

const BackendLambdaFunctionName = `${config.PROJECT_NAME}-lambda-fn`;
const BackendLambdaRestApiGatewayName = `${config.PROJECT_NAME}-lambda-fn-rest-api-gateway`;
const BackendLambdaFunctionUsagePlanName = `${config.PROJECT_NAME}-lambda-fn-usage-plan`;
const BackendLambdaFunctionApiKey = `${config.PROJECT_NAME}-lambda-fn-api-key`;
const BackendLambdaRepositoryName = `${config.PROJECT_NAME}-lambda-fn-repository`;

export class ApiAsset {
  constructor(scope: Construct, { vpc, dbSecurityGroup }: ApiAssetProps) {
    const fnSecurityGroup = new ec2.SecurityGroup(scope, 'SecurityGroup', {
      vpc,
      allowAllOutbound: true,
      securityGroupName: 'VpcEndpoint',
    });

    dbSecurityGroup.addIngressRule(
      fnSecurityGroup,
      ec2.Port.tcp(5432),
      'Allow Postgres traffic from the Lambda function',
    );

    // Create repository for api
    const apiEcrRepository = new ecr.Repository(scope, 'ApiEcrRepository', {
      repositoryName: BackendLambdaRepositoryName,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      encryption: ecr.RepositoryEncryption.AES_256,
    });

    // Create application docker image
    const apiDockerImageAsset = new ecr_assets.DockerImageAsset(
      scope,
      'NodeApiDockerImageAsset',
      {
        directory: path.join(__dirname, '../../../api'),
        followSymlinks: cdk.SymlinkFollowMode.ALWAYS,
        platform: ecr_assets.Platform.LINUX_AMD64,
      },
    );
    const apiDockerImageTag = `${config.PROJECT_NAME}-latest`;
    const apiDockerImageTagName = `${apiEcrRepository.repositoryUri}:${apiDockerImageTag}`;
    new ecrdeploy.ECRDeployment(scope, 'ApiECRDeployment', {
      src: new ecrdeploy.DockerImageName(apiDockerImageAsset.imageUri),
      dest: new ecrdeploy.DockerImageName(apiDockerImageTagName),
    });

    const fn = new lambda.DockerImageFunction(scope, 'ApiLambda', {
      functionName: BackendLambdaFunctionName,
      allowPublicSubnet: false,
      code: lambda.DockerImageCode.fromEcr(apiEcrRepository, {
        tag: apiDockerImageTag,
      }),
      vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        onePerAz: true,
      },
      securityGroups: [fnSecurityGroup],
      memorySize: 512,
      timeout: cdk.Duration.seconds(30),
      architecture: lambda.Architecture.ARM_64,
      environment: {
        // Misc. =====================================================================
        NODE_ENV: 'production',
        PORT: '8080',
        DEBUG: 'false',
        // ===========================================================================

        // Database. =================================================================
        DB_DATABASE: config.DB_NAME,
        DB_USERNAME: config.DB_USERNAME,
        DB_PORT: config.DB_PORT,
        DB_HOST: '',
        DB_PASSWORD: '',
        // ===========================================================================

        // AWS. ======================================================================
        AWS_BUCKET_NAME: 'api-files',
        // ===========================================================================

        FIXED_SHA_256_SALT: '',
        OPENAI_API_KEY: '',
      },
    });

    const api = new apigw.RestApi(scope, 'BackendRestApi', {
      restApiName: BackendLambdaRestApiGatewayName,
      deployOptions: {
        metricsEnabled: true,
        loggingLevel: apigw.MethodLoggingLevel.INFO,
        dataTraceEnabled: true,
      },
      cloudWatchRole: true,
      defaultCorsPreflightOptions: {
        allowOrigins: apigw.Cors.DEFAULT_HEADERS,
        allowMethods: ['POST', 'GET'],
        allowHeaders: apigw.Cors.DEFAULT_HEADERS,
      },
    });

    const apiKey = new apigw.ApiKey(scope, 'ApiKey', {
      apiKeyName: BackendLambdaFunctionApiKey,
      enabled: true,
    });
    const usagePlan = new apigw.UsagePlan(scope, 'UsagePlan', {
      name: BackendLambdaFunctionUsagePlanName,
      apiStages: [{ api, stage: api.deploymentStage }],
      throttle: {
        // The maximum API request rate limit over a time ranging from one to a few seconds.
        burstLimit: 500,
        // The API request steady-state rate limit (average requests per second over an extended period of time)
        rateLimit: 1000,
      },
      quota: {
        // The maximum number of requests that users can make within the specified time period.
        limit: 10000,
        // The time period for which the maximum limit of requests applies.
        period: apigw.Period.DAY,
      },
    });
    usagePlan.addApiKey(apiKey);

    const externalAdapterIntegration = new apigw.LambdaIntegration(fn);

    const baseResource = api.root.addResource('api').addResource('v1');

    const articlesResource = baseResource.addResource('article');
    articlesResource
      .addResource('{id}')
      .addMethod('GET', externalAdapterIntegration);
    const categoriesResource = baseResource.addResource('category');
    categoriesResource
      .addResource('{id}')
      .addMethod('GET', externalAdapterIntegration);

    categoriesResource.addMethod('GET', externalAdapterIntegration, {
      apiKeyRequired: true,
    });
    categoriesResource.addMethod('POST', externalAdapterIntegration, {
      apiKeyRequired: true,
    });
    articlesResource.addMethod('GET', externalAdapterIntegration, {
      apiKeyRequired: true,
    });
    articlesResource.addMethod('POST', externalAdapterIntegration, {
      apiKeyRequired: true,
    });
  }
}
