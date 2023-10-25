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
import * as ecrdeploy from 'cdk-ecr-deployment';
import * as route53 from 'aws-cdk-lib/aws-route53';
import { Construct } from 'constructs';

import { config } from '../../utils/config';
import path = require('path');

interface CustomStackProps extends cdk.StackProps {
  vpc: ec2.Vpc;
  certificate: cm.ICertificate;
  domainZone: route53.IHostedZone;
}

const ClientServiceName = `${config.PROJECT_NAME}-client-service`;
const ClientEcrRepoName = `${config.PROJECT_NAME}-client-ecr-repository`;
const ClientTaskContainerName = `${config.PROJECT_NAME}-client-task-container`;
const ClientTaskContainerFamily = `${config.PROJECT_NAME}-client-task-definition`;
const ClientClusterName = `${config.PROJECT_NAME}-client-ecs-cluster`;
const ClientLogGroupName = `${config.PROJECT_NAME}-client-log-group`;
const ClientLogGroupPrefix = 'client';
const ClientAlbName = `${config.PROJECT_NAME}-client-alb`;
const ClientDomainName = 'client.com';

export class EcsClientAsset {
  public readonly albFargateService: ecsPatterns.ApplicationLoadBalancedFargateService;
  public readonly ecsCluster: ecs.Cluster;
  public readonly ecsTaskRole: iam.IRole;

  constructor(scope: Construct, props: CustomStackProps) {
    const { vpc, certificate, domainZone } = props;

    // Cluster
    this.ecsCluster = new ecs.Cluster(scope, 'ClientEcsCluster', {
      vpc,
      clusterName: ClientClusterName,
      containerInsights: true,
    });

    // ========== Define backend service  ==========
    // Fargate logs
    const fargateLog = new logs.LogGroup(scope, 'ClientLogGroup', {
      logGroupName: ClientLogGroupName,
      retention: logs.RetentionDays.INFINITE,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Create repository for client
    const clientEcrRepository = new ecr.Repository(
      scope,
      'ClientEcrRepository',
      {
        repositoryName: ClientEcrRepoName,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
        encryption: ecr.RepositoryEncryption.AES_256,
      },
    );

    // Create application docker image
    const clientDockerImageAsset = new ecrAssets.DockerImageAsset(
      scope,
      'ClientDockerImageAsset',
      {
        directory: path.join(__dirname, '../../../../client'),
        file: 'Dockerfile.Site',
        platform: ecrAssets.Platform.LINUX_AMD64,
      },
    );
    const clientDockerImageTag = `client-latest`;
    const clientDockerImageTagName = `${clientEcrRepository.repositoryUri}:${clientDockerImageTag}`;
    new ecrdeploy.ECRDeployment(scope, 'ClientECRDeployment', {
      src: new ecrdeploy.DockerImageName(clientDockerImageAsset.imageUri),
      dest: new ecrdeploy.DockerImageName(clientDockerImageTagName),
    });

    // Service
    this.albFargateService =
      new ecsPatterns.ApplicationLoadBalancedFargateService(
        scope,
        'ClientApplicationLoadBalancedFargateService',
        {
          assignPublicIp: false,

          certificate,
          domainName: ClientDomainName,
          domainZone,

          redirectHTTP: true,
          protocol: elbV2.ApplicationProtocol.HTTPS,

          cluster: this.ecsCluster,
          serviceName: ClientServiceName,
          taskSubnets: {
            subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          },
          cpu: 256,
          memoryLimitMiB: 512,
          desiredCount: 1,

          loadBalancerName: ClientAlbName,
          publicLoadBalancer: true,
          openListener: true,

          circuitBreaker: {
            rollback: true,
          },
          enableExecuteCommand: true,
          taskImageOptions: {
            enableLogging: true,
            containerName: ClientTaskContainerName,
            family: ClientTaskContainerFamily,
            image: ecs.ContainerImage.fromEcrRepository(
              clientEcrRepository,
              clientDockerImageTag,
            ),
            containerPort: 3000,
            logDriver: ecs.LogDrivers.awsLogs({
              streamPrefix: ClientLogGroupPrefix,
              logGroup: fargateLog,
            }),
            environment: {
              NODE_ENV: 'production',
              API_URL: '',
              API_KEY: '',
            },
          },
        },
      );

    this.ecsTaskRole = this.albFargateService.service.taskDefinition.taskRole;

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

    const scalableClientTarget =
      this.albFargateService.service.autoScaleTaskCount({
        minCapacity: 1,
        maxCapacity: 2,
      });
    scalableClientTarget.scaleOnCpuUtilization('ClientCPUScaleUP', {
      targetUtilizationPercent: 50,
    });
    scalableClientTarget.scaleOnMemoryUtilization('ClientMemoryScaling', {
      targetUtilizationPercent: 50,
    });
    this.albFargateService.targetGroup.configureHealthCheck({
      healthyThresholdCount: 5,
      unhealthyThresholdCount: 2,
      protocol: elbV2.Protocol.HTTP,
    });
    // ========== Define backend service  ==========
  }
}
