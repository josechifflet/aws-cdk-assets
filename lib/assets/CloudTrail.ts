import {Construct} from 'constructs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import {ReadWriteType, Trail} from 'aws-cdk-lib/aws-cloudtrail';
import {RemovalPolicy} from 'aws-cdk-lib';
import {config} from '../utils/config';

export class CloudTrail {
  trail: Trail;
  constructor(scope: Construct) {
    this.trail = new Trail(scope, `CloudTrail`, {
      isMultiRegionTrail: true,
      sendToCloudWatchLogs: true,
      bucket: new s3.Bucket(scope, `CloudtrailBucketLogs`, {
        bucketName: `${config.PROJECT_NAME}-cloudtrail-bucket-logs`,
        versioned: false,
        removalPolicy: RemovalPolicy.DESTROY,
        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        enforceSSL: true,
        encryption: s3.BucketEncryption.S3_MANAGED,
      }),
      cloudWatchLogsRetention: logs.RetentionDays.INFINITE,
      includeGlobalServiceEvents: true,
      enableFileValidation: true,
    });

    this.trail.logAllS3DataEvents({readWriteType: ReadWriteType.ALL});
    this.trail.logAllLambdaDataEvents({readWriteType: ReadWriteType.ALL});
  }
}
