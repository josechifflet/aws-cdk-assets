import { Vpc } from "aws-cdk-lib/aws-ec2";
import { ApplicationLoadBalancedFargateService } from "aws-cdk-lib/aws-ecs-patterns";
import {
  aws_iam,
  Duration,
  RemovalPolicy,
  StackProps,
  SymlinkFollowMode,
} from "aws-cdk-lib";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";
import * as sm from "aws-cdk-lib/aws-secretsmanager";
import * as ecsPatterns from "aws-cdk-lib/aws-ecs-patterns";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import { DockerImageAsset, Platform } from "aws-cdk-lib/aws-ecr-assets";
import { ContainerImage, FargateService } from "aws-cdk-lib/aws-ecs";
import * as ecr from "aws-cdk-lib/aws-ecr";
import {
  ApplicationProtocol,
  ListenerAction,
  ListenerCondition,
} from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as ecrdeploy from "cdk-ecr-deployment";
import * as cm from "aws-cdk-lib/aws-certificatemanager";
import { config } from "../utils/config";
import {
  API_ECR_REPO_NAME,
  API_SERVICE_NAME,
  AWS_SECRETS_ARN,
  BASE_DOMAIN,
  BASE_URL,
  CLIENT_ECR_REPO_NAME,
  CLIENT_SERVICE_NAME,
  CLIENT_TASK_CONTAINER_FAMILY,
  CLIENT_TASK_CONTAINER_NAME,
  FILES_BUCKET_NAME,
  SHORTENED_BASE_DOMAIN,
  TASK_CONTAINER_FAMILY,
  TASK_CONTAINER_NAME,
} from "../utils/consts";
import path = require("path");
import { aws_docdb as docdb } from "aws-cdk-lib";

interface CustomStackProps extends StackProps {
  vpc: Vpc;
  certificate: cm.ICertificate;
  dbSecret: sm.ISecret;
  db: docdb.DatabaseInstance;
}

export class FargateAsset {
  public readonly services: ApplicationLoadBalancedFargateService;
  public readonly frontendService: FargateService;
  public readonly backendService: FargateService;
  public readonly ecsCluster: ecs.Cluster;
  public readonly ecsTaskRole: iam.IRole;

  constructor(scope: Construct, props: CustomStackProps) {
    const { vpc, dbSecret, certificate, db } = props;

    // Cluster
    this.ecsCluster = new ecs.Cluster(scope, "EcsCluster", {
      vpc,
      clusterName: `${config.PROJECT_NAME}-cluster`,
      containerInsights: true,
    });

    const envSecrets: sm.ISecret = sm.Secret.fromSecretAttributes(
      scope,
      "SecretsManagerImportFromARN",
      { secretCompleteArn: AWS_SECRETS_ARN }
    );

    // ========== Define backend service  ==========
    // Fargate logs
    const fargateLog = new LogGroup(scope, "FargateTaskLogs", {
      logGroupName: `${config.PROJECT_NAME}-api-fargate-tasks-log-groups`,
      retention: RetentionDays.INFINITE,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // Create repository for api
    const apiEcrRepository = new ecr.Repository(scope, "ApiEcrRepository", {
      repositoryName: API_ECR_REPO_NAME,
      removalPolicy: RemovalPolicy.DESTROY,
      encryption: ecr.RepositoryEncryption.AES_256,
    });

    // Create application docker image
    const apiDockerImageAsset = new DockerImageAsset(
      scope,
      "NodeApiDockerImageAsset",
      {
        directory: path.join(__dirname, "../../../backend"),
        followSymlinks: SymlinkFollowMode.ALWAYS,
        platform: Platform.LINUX_AMD64,
      }
    );
    const apiDockerImageTag = `${config.PROJECT_NAME}-latest`;
    const apiDockerImageTagName = `${apiEcrRepository.repositoryUri}:${apiDockerImageTag}`;
    new ecrdeploy.ECRDeployment(scope, "ApiECRDeployment", {
      src: new ecrdeploy.DockerImageName(apiDockerImageAsset.imageUri),
      dest: new ecrdeploy.DockerImageName(apiDockerImageTagName),
    });

    // Service
    this.services = new ecsPatterns.ApplicationLoadBalancedFargateService(
      scope,
      "ApplicationLoadBalancedFargateService",
      {
        assignPublicIp: false,

        // Uncomment when https and dns
        certificate,
        redirectHTTP: true,
        protocol: ApplicationProtocol.HTTPS,

        // Uncomment when http
        // redirectHTTP: false,
        // protocol: ApplicationProtocol.HTTP,

        cluster: this.ecsCluster,
        serviceName: API_SERVICE_NAME,
        taskSubnets: {
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        },
        memoryLimitMiB: 1024,
        cpu: 512,
        desiredCount: 1,
        taskImageOptions: {
          containerName: TASK_CONTAINER_NAME,
          family: TASK_CONTAINER_FAMILY,
          image: ContainerImage.fromEcrRepository(
            apiEcrRepository,
            apiDockerImageTag
          ),
          containerPort: 4000,
          logDriver: ecs.LogDrivers.awsLogs({
            streamPrefix: `${config.PROJECT_NAME}`,
            logGroup: fargateLog,
          }),
          environment: {
            DATABASE_NAME: db.instanceIdentifier,
            WATERTIGHT_BASE_URL: BASE_URL,
            AWS_REGION: "us-west-2",
            AWS_BUCKET_NAME: FILES_BUCKET_NAME,
            AWS_EMAIL_SENDER_NO_REPL: "no-reply@domain.co",
          },
          secrets: {
            NODE_ENV: ecs.Secret.fromSecretsManager(envSecrets, "NODE_ENV"),
            SERVER_NETWORK_PORT: ecs.Secret.fromSecretsManager(
              envSecrets,
              "SERVER_NETWORK_PORT"
            ),
            SERVER_DOCKER_PORT: ecs.Secret.fromSecretsManager(
              envSecrets,
              "SERVER_DOCKER_PORT"
            ),
            COOKIE_SECRET: ecs.Secret.fromSecretsManager(
              envSecrets,
              "COOKIE_SECRET"
            ),
            LOG_LEVEL: ecs.Secret.fromSecretsManager(envSecrets, "LOG_LEVEL"),
            JWT_SECRET: ecs.Secret.fromSecretsManager(envSecrets, "JWT_SECRET"),
            JWT_AUTH_TOKEN_EXP: ecs.Secret.fromSecretsManager(
              envSecrets,
              "JWT_AUTH_TOKEN_EXP"
            ),
            JWT_AUTH_REFRESH_TOKEN_EXP: ecs.Secret.fromSecretsManager(
              envSecrets,
              "JWT_AUTH_REFRESH_TOKEN_EXP"
            ),
            GOOGLE_CLIENT_ID: ecs.Secret.fromSecretsManager(
              envSecrets,
              "GOOGLE_CLIENT_ID"
            ),
            GOOGLE_CLIENT_SECRET: ecs.Secret.fromSecretsManager(
              envSecrets,
              "GOOGLE_CLIENT_SECRET"
            ),
            GOOGLE_OAUTH2_REDIRECT_URL: ecs.Secret.fromSecretsManager(
              envSecrets,
              "GOOGLE_OAUTH2_REDIRECT_URL"
            ),
            GOOGLE_OAUTH2_LIVE_REDIRECT_URL: ecs.Secret.fromSecretsManager(
              envSecrets,
              "GOOGLE_OAUTH2_LIVE_REDIRECT_URL"
            ),
            GOOGLE_OAUTH2_REFRESH_TOKEN_EXPIRATION_DURATION:
              ecs.Secret.fromSecretsManager(
                envSecrets,
                "GOOGLE_OAUTH2_REFRESH_TOKEN_EXPIRATION_DURATION"
              ),
            FACEBOOK_CLIENT_ID: ecs.Secret.fromSecretsManager(
              envSecrets,
              "FACEBOOK_CLIENT_ID"
            ),
            FACEBOOK_CLIENT_SECRET: ecs.Secret.fromSecretsManager(
              envSecrets,
              "FACEBOOK_CLIENT_SECRET"
            ),
            FACEBOOK_CLIENT_OAUTH_REDIRECT_URL: ecs.Secret.fromSecretsManager(
              envSecrets,
              "FACEBOOK_CLIENT_OAUTH_REDIRECT_URL"
            ),
            FACEBOOK_CLIENT_OAUTH_LIVE_REDIRECT_URL:
              ecs.Secret.fromSecretsManager(
                envSecrets,
                "FACEBOOK_CLIENT_OAUTH_LIVE_REDIRECT_URL"
              ),
            FACEBOOK_CLIENT_CONNECT_OAUTH_REDIRECT_URL:
              ecs.Secret.fromSecretsManager(
                envSecrets,
                "FACEBOOK_CLIENT_CONNECT_OAUTH_REDIRECT_URL"
              ),
            LIVE_AUTHORIZATION_CLOSE_URL: ecs.Secret.fromSecretsManager(
              envSecrets,
              "LIVE_AUTHORIZATION_CLOSE_URL"
            ),
            PROXY: ecs.Secret.fromSecretsManager(envSecrets, "PROXY"),
            TIKTOK_CLIENT_KEY: ecs.Secret.fromSecretsManager(
              envSecrets,
              "TIKTOK_CLIENT_KEY"
            ),
            TIKTOK_CLIENT_SECRET: ecs.Secret.fromSecretsManager(
              envSecrets,
              "TIKTOK_CLIENT_SECRET"
            ),
            TIKTOK_CONNECT_OAUTH_REDIRECT_URL: ecs.Secret.fromSecretsManager(
              envSecrets,
              "TIKTOK_CONNECT_OAUTH_REDIRECT_URL"
            ),
            INSTAGRAM_EXPIRATION_DURATION: ecs.Secret.fromSecretsManager(
              envSecrets,
              "INSTAGRAM_EXPIRATION_DURATION"
            ),
            INSTAGRAM_CONNECT_OAUTH_REDIRECT_URL: ecs.Secret.fromSecretsManager(
              envSecrets,
              "INSTAGRAM_CONNECT_OAUTH_REDIRECT_URL"
            ),
            YOUTUBE_CONNECT_OAUTH_REDIRECT_URL: ecs.Secret.fromSecretsManager(
              envSecrets,
              "YOUTUBE_CONNECT_OAUTH_REDIRECT_URL"
            ),
            DATABASE_ADMIN_INTERFACE_USER: ecs.Secret.fromSecretsManager(
              envSecrets,
              "DATABASE_ADMIN_INTERFACE_USER"
            ),
            DATABASE_ADMIN_INTERFACE_PASS: ecs.Secret.fromSecretsManager(
              envSecrets,
              "DATABASE_ADMIN_INTERFACE_PASS"
            ),
            DATABASE_ADMIN_INTERFACE_NETWORK_PORT:
              ecs.Secret.fromSecretsManager(
                envSecrets,
                "DATABASE_ADMIN_INTERFACE_NETWORK_PORT"
              ),

            GOOGLE_API_KEY: ecs.Secret.fromSecretsManager(
              envSecrets,
              "GOOGLE_API_KEY"
            ),

            // Database
            DATABASE_USER: ecs.Secret.fromSecretsManager(dbSecret, "username"),
            DATABASE_PASS: ecs.Secret.fromSecretsManager(dbSecret, "password"),
            DATABASE_HOST: ecs.Secret.fromSecretsManager(dbSecret, "host"),

            CLOUDINARY_CLOUD_NAME: ecs.Secret.fromSecretsManager(
              envSecrets,
              "CLOUDINARY_CLOUD_NAME"
            ),
            CLOUDINARY_API_KEY: ecs.Secret.fromSecretsManager(
              envSecrets,
              "CLOUDINARY_API_KEY"
            ),
            CLOUDINARY_API_SECRET: ecs.Secret.fromSecretsManager(
              envSecrets,
              "CLOUDINARY_API_SECRET"
            ),
          },
        },
      }
    );

    this.backendService = this.services.service;

    this.services.listener.addAction("DefaultALBListenerAction", {
      action: ListenerAction.fixedResponse(404, {
        contentType: "text/html",
        messageBody: "Not Found",
      }),
    });

    this.services.listener.addAction("ForwardALBListenerAction", {
      priority: 3,
      conditions: [
        ListenerCondition.pathPatterns(["/api/*"]),
        ListenerCondition.hostHeaders([
          BASE_DOMAIN,
          SHORTENED_BASE_DOMAIN,
          // `www.${BASE_DOMAIN}`,
          this.services.loadBalancer.loadBalancerDnsName,
        ]),
      ],
      action: ListenerAction.forward([this.services.targetGroup]),
    });

    this.ecsTaskRole = this.backendService.taskDefinition.taskRole;

    dbSecret.grantRead(this.ecsTaskRole);
    envSecrets.grantRead(this.ecsTaskRole);
    this.ecsTaskRole.addToPrincipalPolicy(
      new aws_iam.PolicyStatement({
        sid: "ApiTaskRoleCustomPolicyStatement",
        effect: aws_iam.Effect.ALLOW,
        actions: ["logs:*", "s3:*", "ses:*", "rds:*"],
        resources: ["*"],
      })
    );

    const scalableBackendTarget = this.backendService.autoScaleTaskCount({
      maxCapacity: 2,
      minCapacity: 1,
    });
    scalableBackendTarget.scaleOnCpuUtilization("CPUScaleUP", {
      targetUtilizationPercent: 80,
      scaleInCooldown: Duration.minutes(5),
      scaleOutCooldown: Duration.minutes(10),
    });
    scalableBackendTarget.scaleOnMemoryUtilization("MemoryScaling", {
      targetUtilizationPercent: 70,
      scaleInCooldown: Duration.minutes(15),
      scaleOutCooldown: Duration.minutes(30),
    });
    this.services.targetGroup.configureHealthCheck({
      path: "/api/health",
      healthyThresholdCount: 3,
      unhealthyThresholdCount: 3,
      interval: Duration.seconds(180),
    });
    // ========== Define backend service  ==========

    // ========== Define frontend service  ==========
    const clientEcrRepository = new ecr.Repository(
      scope,
      "ClientEcrRepository",
      {
        repositoryName: CLIENT_ECR_REPO_NAME,
        removalPolicy: RemovalPolicy.DESTROY,
        encryption: ecr.RepositoryEncryption.AES_256,
      }
    );

    // Create application docker image
    const clientDockerImageAsset = new DockerImageAsset(
      scope,
      "NextJsClientDockerImageAsset",
      {
        directory: path.join(__dirname, "../../../client"),
        followSymlinks: SymlinkFollowMode.ALWAYS,
        platform: Platform.LINUX_AMD64,
      }
    );
    const clientDockerImageTag = `${config.PROJECT_NAME}-latest`;
    const clientDockerImageTagName = `${clientEcrRepository.repositoryUri}:${clientDockerImageTag}`;
    new ecrdeploy.ECRDeployment(scope, "ClientECRDeployment", {
      src: new ecrdeploy.DockerImageName(clientDockerImageAsset.imageUri),
      dest: new ecrdeploy.DockerImageName(clientDockerImageTagName),
    });

    const frontendTaskDefinition = new ecs.TaskDefinition(
      scope,
      "FrontendTaskDefinition",
      {
        family: CLIENT_TASK_CONTAINER_FAMILY,
        cpu: "256",
        memoryMiB: "512",
        compatibility: ecs.Compatibility.FARGATE,
      }
    );

    const fargateFrontendLog = new LogGroup(scope, "FrontendLogGroup", {
      logGroupName: `${config.PROJECT_NAME}-frontend-logs`,
      retention: RetentionDays.THREE_MONTHS,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    frontendTaskDefinition.addContainer("FrontendContainer", {
      image: ContainerImage.fromEcrRepository(
        clientEcrRepository,
        clientDockerImageTag
      ),
      containerName: CLIENT_TASK_CONTAINER_NAME,
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: `${config.PROJECT_NAME}-frontend-log-stream`,
        logGroup: fargateFrontendLog,
      }),
      environment: {
        NEXT_PUBLIC_BASE_URL: BASE_URL,
        NEXT_PUBLIC_GRAPHQL_URL: BASE_URL + "/api/graphql",
        NEXT_PUBLIC_SOCKET_URL: "ws://" + BASE_URL,
        AWS_LOAD_BALANCER_URL: this.services.loadBalancer.loadBalancerDnsName,
      },
      portMappings: [{ containerPort: 3000, protocol: ecs.Protocol.TCP }],
    });

    frontendTaskDefinition.taskRole.addToPrincipalPolicy(
      new aws_iam.PolicyStatement({
        sid: "ClientTaskRoleCustomPolicyStatement",
        effect: aws_iam.Effect.ALLOW,
        actions: ["logs:*", "s3:*", "ses:*", "rds:*"],
        resources: ["*"],
      })
    );

    const clientFargateService = new ecs.FargateService(
      scope,
      "FrontendFargateService",
      {
        serviceName: CLIENT_SERVICE_NAME,
        cluster: this.ecsCluster,
        taskDefinition: frontendTaskDefinition,
        desiredCount: 1,
        vpcSubnets: {
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        },
      }
    );

    clientFargateService.registerLoadBalancerTargets({
      containerName: CLIENT_TASK_CONTAINER_NAME,
      containerPort: 3000,
      newTargetGroupId: "client-target-group",
      protocol: ecs.Protocol.TCP,
      listener: ecs.ListenerConfig.applicationListener(this.services.listener, {
        protocol: ApplicationProtocol.HTTP,
        healthCheck: {
          enabled: true,
          healthyHttpCodes: "200-299",
          path: "/",
          interval: Duration.seconds(60),
          healthyThresholdCount: 5,
          unhealthyThresholdCount: 5,
        },
      }),
    });
    // ========== Define frontend service  ==========
  }
}
