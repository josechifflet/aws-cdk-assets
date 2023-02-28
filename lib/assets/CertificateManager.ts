import * as cm from "aws-cdk-lib/aws-certificatemanager";
import { Construct } from "constructs";
import { config } from "../utils/config";

export class CertificateManagerAsset {
  public readonly certificate: cm.ICertificate;

  constructor(scope: Construct) {
    // The certificate must be previously deployed in the console
    this.certificate = cm.Certificate.fromCertificateArn(
      scope,
      `DomainNameCertificate`,
      config.AWS_CERTIFICATE_ARN
    );
  }
}
