import {
  Vpc,
  SecurityGroup,
  Port,
  BastionHostLinux,
} from "aws-cdk-lib/aws-ec2";
import { Duration, RemovalPolicy, StackProps } from "aws-cdk-lib";
import * as rds from "aws-cdk-lib/aws-rds";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import { Construct } from "constructs";
import { Secret } from "aws-cdk-lib/aws-secretsmanager";
import { config } from "../utils/config";

interface CustomStackProps extends StackProps {
  vpc: Vpc;
  bastionHost: BastionHostLinux;
}

export class RdsAsset {
  public readonly databaseHost: rds.Endpoint;
  public readonly databaseUsername: string;
  public readonly databasePassword: string;

  public readonly databasePasswordSecret: Secret;

  constructor(scope: Construct, props: CustomStackProps) {
    const { vpc, bastionHost } = props;

    const databaseCredentialsSecret = new Secret(
      scope,
      `DatabaseCredentialsSecret`,
      {
        secretName: `/${config.PROJECT_NAME}/db-credentials`,
        description: "Credentials to access RDS",
        generateSecretString: {
          secretStringTemplate: JSON.stringify({
            username: config.DB_USERNAME,
          }),
          excludePunctuation: true,
          includeSpace: false,
          generateStringKey: "password",
        },
      }
    );

    this.databasePasswordSecret = databaseCredentialsSecret;

    const dbClusterSecurityGroup = new SecurityGroup(
      scope,
      `DatabaseClusterSecurityGroup`,
      { vpc }
    );

    // Allow connections to DB port from private subnets
    for (const privateSubnet of vpc.privateSubnets) {
      dbClusterSecurityGroup.addIngressRule(
        ec2.Peer.ipv4(privateSubnet.ipv4CidrBlock),
        Port.tcp(config.DB_PORT)
      );
    }

    // Allow connections to DB port from public subnets
    for (const publicSubnet of vpc.publicSubnets) {
      dbClusterSecurityGroup.addIngressRule(
        ec2.Peer.ipv4(publicSubnet.ipv4CidrBlock),
        Port.tcp(config.DB_PORT)
      );
    }

    const rdsCluster = new rds.ServerlessCluster(scope, `DatabaseRDS`, {
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        version: rds.AuroraPostgresEngineVersion.VER_11_16,
      }),
      credentials: rds.Credentials.fromSecret(databaseCredentialsSecret),
      defaultDatabaseName: config.DB_DATABASE,
      vpc,
      securityGroups: [dbClusterSecurityGroup],
      deletionProtection: true,
      removalPolicy: RemovalPolicy.RETAIN,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
      },
      scaling: {
        autoPause: Duration.hours(24),
        minCapacity: 2,
        maxCapacity: 16,
      },
      backupRetention: Duration.days(10),
    });

    rdsCluster.connections.allowFrom(
      bastionHost.connections,
      Port.tcp(rdsCluster.clusterEndpoint.port),
      "Bastion host connection"
    );

    this.databaseHost = rdsCluster.clusterEndpoint;
    this.databaseUsername = databaseCredentialsSecret
      .secretValueFromJson("username")
      .toString();
    this.databasePassword = databaseCredentialsSecret
      .secretValueFromJson("password")
      .toString();
  }
}
