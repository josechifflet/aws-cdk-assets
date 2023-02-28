import {
  BastionHostLinux,
  IVpc,
  Peer,
  Port,
  SecurityGroup,
  SubnetType,
} from "aws-cdk-lib/aws-ec2";
import { Construct } from "constructs";
import { BASTION_HOST_INSTANCE_NAME } from "../utils/consts";

interface Props {
  vpc: IVpc;
}

export class BastionHostAsset {
  public readonly bastionHost: BastionHostLinux;

  constructor(scope: Construct, props: Props) {
    const { vpc } = props;
    const bastionHostSecurityGroup = new SecurityGroup(
      scope,
      `BastionHostSecurityGroup`,
      { vpc, allowAllOutbound: true }
    );

    this.bastionHost = new BastionHostLinux(scope, `BastionHost`, {
      vpc: props.vpc,
      subnetSelection: {
        subnetType: SubnetType.PUBLIC,
      },
      instanceName: BASTION_HOST_INSTANCE_NAME,
      securityGroup: bastionHostSecurityGroup,
    });
  }
}
