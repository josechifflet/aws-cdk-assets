import { StackProps, RemovalPolicy, CfnOutput } from "aws-cdk-lib";
import * as s3 from "aws-cdk-lib/aws-s3";
import { BucketDeployment, Source } from "aws-cdk-lib/aws-s3-deployment";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import {
  OriginAccessIdentity,
  AllowedMethods,
  ViewerProtocolPolicy,
  OriginProtocolPolicy,
  Distribution,
  CachePolicy,
  SecurityPolicyProtocol,
  SSLMethod,
} from "aws-cdk-lib/aws-cloudfront";
import * as cm from "aws-cdk-lib/aws-certificatemanager";
import { Construct } from "constructs";
import { config } from "../utils/config";

interface CustomStackProps extends StackProps {
  albEndpoint: string;
  // certificate: cm.ICertificate;
}

export class CloudfrontAsset {
  public readonly cloudFrontDist: Distribution;

  constructor(scope: Construct, props: CustomStackProps) {
    // Web hosting bucket
    const websiteBucket = new s3.Bucket(scope, `WebsiteBucket`, {
      // bucketName: /** DomainName */,
      versioned: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      cors: [{ allowedOrigins: ["*"], allowedMethods: [s3.HttpMethods.GET] }],
    });

    // Create Origin Access Identity for CloudFront
    const originAccessIdentity = new OriginAccessIdentity(
      scope,
      `CloudfrontOAI`,
      { comment: "OAI for web application cloudfront distribution" }
    );
    websiteBucket.grantRead(originAccessIdentity);

    // Creating CloudFront distribution
    this.cloudFrontDist = new Distribution(scope, `PortalCloudfrontDist`, {
      defaultRootObject: "index.html",
      defaultBehavior: {
        origin: new origins.S3Origin(websiteBucket, { originAccessIdentity }),
        compress: true,
        allowedMethods: AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      },
      // Uncomment when domain name
      // domainNames: [],
      // certificate: props.certificate,
      minimumProtocolVersion: SecurityPolicyProtocol.TLS_V1_2_2021,
      sslSupportMethod: SSLMethod.SNI,
      enableLogging: true,
      logBucket: new s3.Bucket(scope, `PortalDistLogAccessBucketLogs`, {
        bucketName: `${config.PROJECT_NAME}-portal-dist-log-access-logs`,
        versioned: false,
        removalPolicy: RemovalPolicy.DESTROY,
        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        enforceSSL: true,
        encryption: s3.BucketEncryption.S3_MANAGED,
      }),
      logFilePrefix: "portal-dist-access-logs/",
      logIncludesCookies: true,
      errorResponses: [
        { httpStatus: 400, responsePagePath: "/index.html" },
        { httpStatus: 403, responsePagePath: "/index.html" },
        { httpStatus: 404, responsePagePath: "/index.html" },
        { httpStatus: 405, responsePagePath: "/index.html" },
        { httpStatus: 414, responsePagePath: "/index.html" },
        { httpStatus: 416, responsePagePath: "/index.html" },
        { httpStatus: 500, responsePagePath: "/index.html" },
        { httpStatus: 501, responsePagePath: "/index.html" },
        { httpStatus: 502, responsePagePath: "/index.html" },
        { httpStatus: 503, responsePagePath: "/index.html" },
        { httpStatus: 504, responsePagePath: "/index.html" },
      ],
    });

    // Trigger frontend deployment
    new BucketDeployment(scope, `BucketDeployment`, {
      sources: [Source.asset("../portal/build/")],
      destinationBucket: websiteBucket,
      distribution: this.cloudFrontDist,
      distributionPaths: ["/*"],
    });

    // Creating custom origin for the application load balancer
    const loadBalancerOrigin = new origins.HttpOrigin(props.albEndpoint, {
      protocolPolicy: OriginProtocolPolicy.HTTPS_ONLY,
    });

    this.cloudFrontDist.addBehavior("/api/health", loadBalancerOrigin, {
      cachePolicy: CachePolicy.CACHING_DISABLED,
      viewerProtocolPolicy: ViewerProtocolPolicy.ALLOW_ALL,
      allowedMethods: AllowedMethods.ALLOW_ALL,
    });

    new CfnOutput(scope, `CloudfrontDomainUrl`, {
      value: this.cloudFrontDist.distributionDomainName,
      exportName: `${config.PROJECT_NAME}cloudfrontDomainUrl`,
    });
  }
}
