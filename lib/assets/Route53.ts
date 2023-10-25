import * as route53 from 'aws-cdk-lib/aws-route53';
import { Construct } from 'constructs';

import { config } from '../utils/config';

export class Route53HostedZoneAsset {
  public readonly route53HostedZone: route53.IHostedZone;

  constructor(scope: Construct) {
    this.route53HostedZone = route53.HostedZone.fromHostedZoneAttributes(
      scope,
      'HostedZone',
      {
        hostedZoneId: config.ROUTE_53_HOSTED_ZONE_ID,
        zoneName: config.ROUTE_53_HOSTED_ZONE_NAME,
      },
    );
  }
}
