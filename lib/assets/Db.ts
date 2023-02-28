import {
  Vpc,
  SecurityGroup,
  Port,
  BastionHostLinux,
} from "aws-cdk-lib/aws-ec2";
import { RemovalPolicy, SecretValue, StackProps } from "aws-cdk-lib";
import { aws_docdb as docdb } from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import { Construct } from "constructs";
import { ISecret, Secret } from "aws-cdk-lib/aws-secretsmanager";
import { config } from "../utils/config";

interface CustomStackProps extends StackProps {
  vpc: Vpc;
  bastionHost: BastionHostLinux;
}

export class Db {
  public readonly databaseHost: docdb.Endpoint;
  public readonly databaseUsername: string;
  public readonly databasePassword: string;

  public readonly databasePasswordSecret: ISecret;
  public readonly cluster: docdb.DatabaseCluster;
  public readonly database: docdb.DatabaseInstance;

  constructor(scope: Construct, props: CustomStackProps) {
    const { vpc, bastionHost } = props;

    const dbClusterSecurityGroup = new SecurityGroup(
      scope,
      `DatabaseClusterSecurityGroup`,
      { vpc }
    );

    const databaseCredentialsSecret = new Secret(
      scope,
      `DatabaseCredentialsSecret`,
      {
        secretName: `/${config.PROJECT_NAME}/documentdb/credentials`,
        generateSecretString: {
          secretStringTemplate: JSON.stringify({
            username: "root",
          }),
          excludePunctuation: true,
          includeSpace: false,
          generateStringKey: "password",
        },
      }
    );

    const cluster = new docdb.DatabaseCluster(scope, "Database", {
      vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
      },
      masterUser: {
        username: "root",
        password: SecretValue.secretsManager(
          databaseCredentialsSecret.secretArn,
          { jsonField: "password" }
        ),
      },
      /** instance free tier */
      instances: 1,
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.T3,
        ec2.InstanceSize.MEDIUM
      ),
      exportAuditLogsToCloudWatch: true,
      exportProfilerLogsToCloudWatch: true,
      storageEncrypted: true,
      port: docdb.DatabaseCluster.DEFAULT_PORT,
      removalPolicy: RemovalPolicy.DESTROY,
      securityGroup: dbClusterSecurityGroup,
    });

    databaseCredentialsSecret.attach(cluster);

    this.database = new docdb.DatabaseInstance(scope, "DatabaseInstance", {
      cluster,
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.T3,
        ec2.InstanceSize.MEDIUM
      ),
      removalPolicy: RemovalPolicy.DESTROY,
    });

    this.databasePasswordSecret = databaseCredentialsSecret;

    cluster.connections.allowFrom(
      bastionHost.connections,
      Port.tcp(cluster.clusterEndpoint.port),
      "Bastion host connection"
    );

    this.databaseHost = cluster.clusterEndpoint;
    this.databaseUsername = this.databasePasswordSecret
      .secretValueFromJson("username")
      .toString();
    this.databasePassword = this.databasePasswordSecret
      .secretValueFromJson("password")
      .toString();
  }
}
