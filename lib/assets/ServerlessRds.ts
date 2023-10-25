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

const SlsDbSecretName = `${config.PROJECT_NAME}-chainlink-node-postgres-db-credentials`;
const SlsDbClusterName = `${config.PROJECT_NAME}-chainlink-node-postgres-db-cluster`;
const SlsDbClusterInstanceWriterIdentifier = `${config.PROJECT_NAME}-chainlink-node-postgres-db-cluster-writer`;
export class SlsDatabaseAsset {
  public readonly databaseHost: rds.Endpoint;
  public readonly databaseUsername: string;
  public readonly databasePassword: string;

  public readonly databasePasswordSecret: secretsmanager.Secret;

  constructor(scope: Construct, props: CustomStackProps) {
    const { vpc, bastionHost } = props;

    const databaseCredentialsSecret = new secretsmanager.Secret(
      scope,
      'SlsDatabaseCredentialsSecret',
      {
        secretName: SlsDbSecretName,
        description: 'Credentials to access RDS',
        generateSecretString: {
          secretStringTemplate: JSON.stringify({
            username: config.CL_DB_USERNAME,
          }),
          excludePunctuation: true,
          includeSpace: false,
          generateStringKey: 'password',
        },
      },
    );

    this.databasePasswordSecret = databaseCredentialsSecret;

    const dbClusterSecurityGroup = new ec2.SecurityGroup(
      scope,
      'SlsDatabaseClusterSecurityGroup',
      { vpc },
    );

    // Allow connections to DB port from private subnets
    for (const privateSubnet of vpc.privateSubnets) {
      dbClusterSecurityGroup.addIngressRule(
        ec2.Peer.ipv4(privateSubnet.ipv4CidrBlock),
        ec2.Port.tcp(+config.CL_DB_PORT),
      );
    }

    // Allow connections to DB port from public subnets
    for (const publicSubnet of vpc.publicSubnets) {
      dbClusterSecurityGroup.addIngressRule(
        ec2.Peer.ipv4(publicSubnet.ipv4CidrBlock),
        ec2.Port.tcp(+config.CL_DB_PORT),
      );
    }

    const database = new rds.DatabaseCluster(
      scope,
      'SlsDatabaseCluster',
      {
        engine: rds.DatabaseClusterEngine.auroraPostgres({
          version: rds.AuroraPostgresEngineVersion.VER_15_3,
        }),
        vpc,
        vpcSubnets: {
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        },
        securityGroups: [dbClusterSecurityGroup],

        credentials: rds.Credentials.fromSecret(databaseCredentialsSecret),
        defaultDatabaseName: config.CL_DB_NAME,
        clusterIdentifier: SlsDbClusterName,
        removalPolicy: cdk.RemovalPolicy.DESTROY,

        deletionProtection: false,
        storageEncrypted: true,
        cloudwatchLogsRetention: logs.RetentionDays.ONE_MONTH,

        backup: {
          retention: cdk.Duration.days(10),
          preferredWindow: '07:00-09:00',
        },

        writer: rds.ClusterInstance.serverlessV2(
          'SlsDatabaseClusterServerlessWriter',
          {
            publiclyAccessible: false,
            enablePerformanceInsights: true,
            performanceInsightRetention:
              rds.PerformanceInsightRetention.MONTHS_1,
            instanceIdentifier: SlsDbClusterInstanceWriterIdentifier,
            allowMajorVersionUpgrade: true,
          },
        ),

        monitoringInterval: cdk.Duration.seconds(60),

        serverlessV2MaxCapacity: 4,
        serverlessV2MinCapacity: 2,

        subnetGroup: new rds.SubnetGroup(
          scope,
          'SlsDatabaseClusterSubnetGroup',
          {
            vpc,
            description:
              'Subnet group for the chainlink node postgres database cluster',
            vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
          },
        ),
      },
    );

    /**
     * If this metric approaches a value of 100.0, the DB instance has reached its maximum CPU capacity.
     * Consider increasing the maximum ACU setting for the cluster.
     */
    const metricCPUUtilization = database.metricCPUUtilization({
      period: cdk.Duration.minutes(1),
    });
    /**
     * This value represents the amount of unused memory that is available when the Aurora Serverless v2 DB instance
     * is scaled to its maximum capacity. For every ACU that the current capacity is below the maximum capacity, this
     * value increases by approximately 2 GiB. Thus, this metric doesn't approach zero until the DB instance is scaled up as high as it can.
     * If this metric approaches a value of 0, the DB instance has scaled up as much as it can and is nearing the limit of its available memory.
     * Consider increasing the maximum ACU setting for the cluster.
     */
    const metricFreeableMemory = database.metricFreeableMemory({
      period: cdk.Duration.minutes(1),
    });
    /**
     * This value is represented as a percentage. It's calculated as the value of the ServerlessDatabaseCapacity metric divided by the maximum ACU value of the DB cluster.
     * If this metric approaches a value of 100.0, the DB instance has scaled up as high as it can. Consider increasing the maximum ACU setting for the cluster.
     *
     * Suppose that you are running a production application, where performance and scalability are the primary considerations.
     * In that case, you can set the maximum ACU value for the cluster to a high number. Your goal is for the ACUUtilization metric to always be below 100.0.
     * With a high maximum ACU value, you can be confident that there's enough room in case there are unexpected spikes in database activity.
     * You are only charged for the database capacity that's actually consumed.
     */
    const metricACUUtilization = database.metric(
      'SlsDatabaseACUUtilization',
      {
        period: cdk.Duration.minutes(1),
      },
    );

    // CloudWatch alarms for CPU Utilization metrics set to alarm state when CPU os over 50 percent
    metricCPUUtilization.createAlarm(scope, 'SlsDatabaseCpu70Alarm', {
      evaluationPeriods: 1,
      alarmDescription: 'Cluster CPU Over 70 Percent',
      threshold: 70,
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    });
    metricFreeableMemory.createAlarm(
      scope,
      'SlsDatabaseFreeableMemoryApproachingZeroAlarm',
      {
        evaluationPeriods: 1,
        alarmDescription: 'Cluster Freeable Memory Approaching Zero',
        threshold: 3,
        comparisonOperator:
          cloudwatch.ComparisonOperator.LESS_THAN_OR_EQUAL_TO_THRESHOLD,
      },
    );
    metricACUUtilization.createAlarm(
      scope,
      'SlsDatabaseACUs70Alarm',
      {
        evaluationPeriods: 1,
        alarmDescription: 'Cluster ACUs Over 70 Percent',
        threshold: 70,
        comparisonOperator:
          cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      },
    );

    database.connections.allowFrom(
      bastionHost.connections,
      ec2.Port.tcp(database.clusterEndpoint.port),
      'Bastion host connection',
    );

    this.databaseHost = database.clusterEndpoint;
    this.databaseUsername = databaseCredentialsSecret
      .secretValueFromJson('username')
      .toString();
    this.databasePassword = databaseCredentialsSecret
      .secretValueFromJson('password')
      .toString();
  }
}
