import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

import { config } from '../utils/config';

interface CustomStackProps extends cdk.StackProps {
  vpc: ec2.Vpc;
  bastionHost: ec2.BastionHostLinux;
}

const DbSecretName = `${config.PROJECT_NAME}-db-credentials`;
const DbClusterName = `${config.PROJECT_NAME}-db-cluster`;
const DbClusterWriterInstanceName = `${config.PROJECT_NAME}-db-cluster-writer-instance`;

export class RdsAsset {
  public readonly dbHost: rds.Endpoint;
  public readonly dbUsername: string;
  public readonly dbPassword: string;

  public readonly dbPasswordSecret: secretsmanager.Secret;
  public readonly dbSecurityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, props: CustomStackProps) {
    const { vpc, bastionHost } = props;

    const dbCredentialsSecret = new secretsmanager.Secret(
      scope,
      'DatabaseCredentialsSecret',
      {
        secretName: DbSecretName,
        description: 'Credentials to access RDS',
        generateSecretString: {
          secretStringTemplate: JSON.stringify({
            username: config.DB_USERNAME,
          }),
          excludePunctuation: true,
          includeSpace: false,
          generateStringKey: 'password',
        },
      },
    );

    this.dbPasswordSecret = dbCredentialsSecret;

    const dbClusterSecurityGroup = new ec2.SecurityGroup(
      scope,
      'DatabaseClusterSecurityGroup',
      { vpc },
    );
    this.dbSecurityGroup = dbClusterSecurityGroup;

    // Allow connections to DB port from private subnets
    for (const privateSubnet of vpc.privateSubnets) {
      dbClusterSecurityGroup.addIngressRule(
        ec2.Peer.ipv4(privateSubnet.ipv4CidrBlock),
        ec2.Port.tcp(+config.DB_PORT),
      );
    }

    // Allow connections to DB port from public subnets
    for (const publicSubnet of vpc.publicSubnets) {
      dbClusterSecurityGroup.addIngressRule(
        ec2.Peer.ipv4(publicSubnet.ipv4CidrBlock),
        ec2.Port.tcp(+config.DB_PORT),
      );
    }

    const db = new rds.DatabaseCluster(scope, 'DatabaseCluster', {
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        version: rds.AuroraPostgresEngineVersion.VER_15_3,
      }),
      vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        onePerAz: true,
      },
      securityGroups: [dbClusterSecurityGroup],

      credentials: rds.Credentials.fromSecret(dbCredentialsSecret),
      defaultDatabaseName: config.DB_NAME,
      clusterIdentifier: DbClusterName,
      removalPolicy: cdk.RemovalPolicy.DESTROY,

      deletionProtection: false,
      storageEncrypted: true,
      cloudwatchLogsRetention: logs.RetentionDays.ONE_MONTH,

      backup: {
        retention: cdk.Duration.days(10),
        preferredWindow: '07:00-09:00',
      },

      writer: rds.ClusterInstance.provisioned('ClusterInstanceWriter', {
        instanceIdentifier: DbClusterWriterInstanceName,
        publiclyAccessible: false,
        enablePerformanceInsights: true,
        performanceInsightRetention: rds.PerformanceInsightRetention.MONTHS_1,
      }),

      monitoringInterval: cdk.Duration.seconds(60),

      serverlessV2MaxCapacity: 2,
      serverlessV2MinCapacity: 1,

      // serverlessV2MaxCapacity: 8,
      // serverlessV2MinCapacity: 2,
    });

    /**
     * If this metric approaches a value of 100.0, the DB instance has reached its maximum CPU capacity.
     * Consider increasing the maximum ACU setting for the cluster.
     */
    const metricCPUUtilization = db.metricCPUUtilization({
      period: cdk.Duration.minutes(1),
    });
    /**
     * This value represents the amount of unused memory that is available when the Aurora Serverless v2 DB instance
     * is scaled to its maximum capacity. For every ACU that the current capacity is below the maximum capacity, this
     * value increases by approximately 2 GiB. Thus, this metric doesn't approach zero until the DB instance is scaled up as high as it can.
     * If this metric approaches a value of 0, the DB instance has scaled up as much as it can and is nearing the limit of its available memory.
     * Consider increasing the maximum ACU setting for the cluster.
     */
    const metricFreeableMemory = db.metricFreeableMemory({
      period: cdk.Duration.minutes(1),
    });
    /**
     * This value is represented as a percentage. It's calculated as the value of the ServerlessDatabaseCapacity metric divided by the maximum ACU value of the DB cluster.
     * If this metric approaches a value of 100.0, the DB instance has scaled up as high as it can. Consider increasing the maximum ACU setting for the cluster.
     *
     * Suppose that you are running a production application, where performance and scalability are the primary considerations.
     * In that case, you can set the maximum ACU value for the cluster to a high number. Your goal is for the ACUUtilization metric to always be below 100.0.
     * With a high maximum ACU value, you can be confident that there's enough room in case there are unexpected spikes in db activity.
     * You are only charged for the db capacity that's actually consumed.
     */
    const metricACUUtilization = db.metric('DatabaseACUUtilization', {
      period: cdk.Duration.minutes(1),
    });

    // CloudWatch alarms for CPU Utilization metrics set to alarm state when CPU os over 50 percent
    metricCPUUtilization.createAlarm(scope, 'DatabaseCpu70Alarm', {
      evaluationPeriods: 1,
      alarmDescription: 'Cluster CPU Over 70 Percent',
      threshold: 70,
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    });
    metricFreeableMemory.createAlarm(
      scope,
      'DatabaseFreeableMemoryApproachingZeroAlarm',
      {
        evaluationPeriods: 1,
        alarmDescription: 'Cluster Freeable Memory Approaching Zero',
        threshold: 3,
        comparisonOperator:
          cloudwatch.ComparisonOperator.LESS_THAN_OR_EQUAL_TO_THRESHOLD,
      },
    );
    metricACUUtilization.createAlarm(scope, 'DatabaseACUs70Alarm', {
      evaluationPeriods: 1,
      alarmDescription: 'Cluster ACUs Over 70 Percent',
      threshold: 70,
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    });

    db.connections.allowFrom(
      bastionHost.connections,
      ec2.Port.tcp(db.clusterEndpoint.port),
      'Bastion host connection',
    );

    this.dbHost = db.clusterEndpoint;
    this.dbUsername = dbCredentialsSecret
      .secretValueFromJson('username')
      .toString();
    this.dbPassword = dbCredentialsSecret
      .secretValueFromJson('password')
      .toString();
  }
}
