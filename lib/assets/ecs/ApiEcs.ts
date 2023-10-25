import * as cdk from 'aws-cdk-lib';
import * as cm from 'aws-cdk-lib/aws-certificatemanager';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecrAssets from 'aws-cdk-lib/aws-ecr-assets';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecsPatterns from 'aws-cdk-lib/aws-ecs-patterns';
import * as elbV2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sm from 'aws-cdk-lib/aws-secretsmanager';
import * as ecrdeploy from 'cdk-ecr-deployment';
import * as route53 from 'aws-cdk-lib/aws-route53';
import { Construct } from 'constructs';

import { config } from '../../utils/config';
import path = require('path');

interface CustomStackProps extends cdk.StackProps {
  vpc: ec2.Vpc;
  dbPasswordSecret: sm.ISecret;
  certificate: cm.ICertificate;
  domainZone: route53.IHostedZone;
}

const ApiServiceName = `${config.PROJECT_NAME}-api-service`;
const ApiEcrRepoName = `${config.PROJECT_NAME}-api-ecr-repository`;
const ApiTaskContainerName = `${config.PROJECT_NAME}-api-task-container`;
const ApiTaskContainerFamily = `${config.PROJECT_NAME}-api-task-definition`;
const ApiEcsCluster = `${config.PROJECT_NAME}-api-ecs-cluster`;
const ApiLogGroupName = `${config.PROJECT_NAME}-api-log-group`;
const ApiLogGroupPrefix = 'api';
const ApiAlbName = `${config.PROJECT_NAME}-api-alb`;
const ApiDomainName = 'api.client.com';

export class EcsApiAsset {
  public readonly albFargateService: ecsPatterns.ApplicationLoadBalancedFargateService;
  public readonly ecsCluster: ecs.Cluster;
  public readonly ecsTaskRole: iam.IRole;

  constructor(scope: Construct, props: CustomStackProps) {
    const { vpc, dbPasswordSecret, certificate, domainZone } = props;

    // Cluster
    this.ecsCluster = new ecs.Cluster(scope, 'BackendEcsCluster', {
      vpc,
      clusterName: ApiEcsCluster,
      containerInsights: true,
    });

    // Import secrets from arn
    const envSecrets: sm.ISecret = sm.Secret.fromSecretAttributes(
      scope,
      'BackendSecretsImportFromARN',
      { secretCompleteArn: config.API_SECRETS_ARN },
    );

    // ========== Define backend service  ==========
    // Fargate logs
    const fargateLog = new logs.LogGroup(scope, 'BackendLogGroup', {
      logGroupName: ApiLogGroupName,
      retention: logs.RetentionDays.INFINITE,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Create repository for api
    const apiEcrRepository = new ecr.Repository(scope, 'BackendEcrRepository', {
      repositoryName: ApiEcrRepoName,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      encryption: ecr.RepositoryEncryption.AES_256,
    });

    // Create application docker image
    const apiDockerImageAsset = new ecrAssets.DockerImageAsset(
      scope,
      'BackendDockerImageAsset',
      {
        directory: path.join(__dirname, '../../../../api'),
        followSymlinks: cdk.SymlinkFollowMode.ALWAYS,
        platform: ecrAssets.Platform.LINUX_AMD64,
      },
    );
    const apiDockerImageTag = `api-latest`;
    const apiDockerImageTagName = `${apiEcrRepository.repositoryUri}:${apiDockerImageTag}`;
    new ecrdeploy.ECRDeployment(scope, 'BackendECRDeployment', {
      src: new ecrdeploy.DockerImageName(apiDockerImageAsset.imageUri),
      dest: new ecrdeploy.DockerImageName(apiDockerImageTagName),
    });

    // Service
    this.albFargateService =
      new ecsPatterns.ApplicationLoadBalancedFargateService(
        scope,
        'BackendApplicationLoadBalancedFargateService',
        {
          assignPublicIp: false,

          certificate,
          domainName: ApiDomainName,
          domainZone,

          redirectHTTP: true,
          protocol: elbV2.ApplicationProtocol.HTTPS,

          cluster: this.ecsCluster,
          serviceName: ApiServiceName,
          taskSubnets: {
            subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          },
          cpu: 256,
          memoryLimitMiB: 512,
          desiredCount: 1,

          loadBalancerName: ApiAlbName,
          publicLoadBalancer: true,
          openListener: true,

          circuitBreaker: { rollback: true },
          enableExecuteCommand: true,
          taskImageOptions: {
            enableLogging: true,
            containerName: ApiTaskContainerName,
            family: ApiTaskContainerFamily,
            image: ecs.ContainerImage.fromEcrRepository(
              apiEcrRepository,
              apiDockerImageTag,
            ),
            containerPort: +config.API_PORT,
            logDriver: ecs.LogDrivers.awsLogs({
              streamPrefix: ApiLogGroupPrefix,
              logGroup: fargateLog,
            }),
            environment: {
              AWS_DEFAULT_REGION: 'us-west-2',
            },
            secrets: {
              NODE_ENV: ecs.Secret.fromSecretsManager(envSecrets, 'NODE_ENV'),
              PORT: ecs.Secret.fromSecretsManager(envSecrets, 'PORT'),
              DEBUG: ecs.Secret.fromSecretsManager(envSecrets, 'DEBUG'),
              DB_DATABASE: ecs.Secret.fromSecretsManager(
                dbPasswordSecret,
                'dbname',
              ),
              DB_HOST: ecs.Secret.fromSecretsManager(dbPasswordSecret, 'host'),
              DB_PASSWORD: ecs.Secret.fromSecretsManager(
                dbPasswordSecret,
                'password',
              ),
              DB_PORT: ecs.Secret.fromSecretsManager(dbPasswordSecret, 'port'),
              DB_USERNAME: ecs.Secret.fromSecretsManager(
                dbPasswordSecret,
                'username',
              ),
              DB_CONNECTOR: ecs.Secret.fromSecretsManager(
                dbPasswordSecret,
                'engine',
              ),

              AWS_BUCKET_NAME: ecs.Secret.fromSecretsManager(
                envSecrets,
                'AWS_BUCKET_NAME',
              ),

              FIXED_SHA_256_SALT: ecs.Secret.fromSecretsManager(
                envSecrets,
                'FIXED_SHA_256_SALT',
              ),
              OPENAI_API_KEY: ecs.Secret.fromSecretsManager(
                envSecrets,
                'OPENAI_API_KEY',
              ),
              API_KEY: ecs.Secret.fromSecretsManager(envSecrets, 'API_KEY'),
              ORIGIN: ecs.Secret.fromSecretsManager(envSecrets, 'ORIGIN'),
            },
          },
        },
      );

    this.albFargateService.listener.addAction(
      'BackendDefaultALBListenerAction',
      {
        action: elbV2.ListenerAction.fixedResponse(404, {
          contentType: 'text/html',
          messageBody: 'Not Found',
        }),
      },
    );

    this.albFargateService.listener.addAction(
      'BackendForwardALBListenerAction',
      {
        priority: 2,
        conditions: [
          elbV2.ListenerCondition.pathPatterns(['/api/*']),
          elbV2.ListenerCondition.hostHeaders([
            ApiDomainName,
            this.albFargateService.loadBalancer.loadBalancerDnsName,
          ]),
        ],
        action: elbV2.ListenerAction.forward([
          this.albFargateService.targetGroup,
        ]),
      },
    );

    this.ecsTaskRole = this.albFargateService.service.taskDefinition.taskRole;

    dbPasswordSecret.grantRead(this.ecsTaskRole);
    envSecrets.grantRead(this.ecsTaskRole);

    this.ecsTaskRole.addToPrincipalPolicy(
      new cdk.aws_iam.PolicyStatement({
        sid: 'ApiTaskRoleCustomPolicyStatement',
        effect: cdk.aws_iam.Effect.ALLOW,
        actions: [
          'logs:*',
          's3:*',
          'ses:*',
          'rds:*',
          'sqs:*',
          'sns:*',
          'events:*',
          'lambda:*',
        ],
        resources: ['*'],
      }),
    );

    const scalableBackendTarget =
      this.albFargateService.service.autoScaleTaskCount({
        minCapacity: 1,
        maxCapacity: 2,
      });
    scalableBackendTarget.scaleOnCpuUtilization('BackendCPUScaleUP', {
      targetUtilizationPercent: 50,
    });
    scalableBackendTarget.scaleOnMemoryUtilization('BackendMemoryScaling', {
      targetUtilizationPercent: 50,
    });

    this.albFargateService.targetGroup.configureHealthCheck({
      path: '/api/health',
      healthyThresholdCount: 5,
      unhealthyThresholdCount: 2,
      protocol: elbV2.Protocol.HTTP,
    });
    // ========== Define backend service  ==========
  }
}
