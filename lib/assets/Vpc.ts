import { SubnetType, Vpc } from "aws-cdk-lib/aws-ec2";
import { Construct } from "constructs";
import { config } from "../utils/config";

export class VpcAsset {
  public readonly vpc: Vpc;
  constructor(scope: Construct) {
    this.vpc = new Vpc(scope, `${config.PROJECT_NAME}-vpc`, {
      cidr: "10.0.0.0/16",
      natGateways: 2,
      maxAzs: 2,
      subnetConfiguration: [
        {
          // A private subnet is one that is configured to use a NAT Gateway (NAT) so that it can reach the internet,
          // but which prevents the internet from initiating connections to it.
          name: "private-subnet",
          subnetType: SubnetType.PRIVATE_WITH_EGRESS,
        },
        {
          // A public subnet is one whose traffic is routed to an Internet Gateway (IGW).
          name: "public-subnet",
          subnetType: SubnetType.PUBLIC,
        },
        {
          // An isolated subnet is one that cannot reach the internet either through an IGW or with NAT.
          name: "isolated-subnet",
          subnetType: SubnetType.PRIVATE_ISOLATED,
        },
      ],
    });
  }
}
