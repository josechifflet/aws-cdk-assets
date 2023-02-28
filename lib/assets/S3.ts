import { RemovalPolicy, StackProps } from "aws-cdk-lib";
import * as aws_iam from "aws-cdk-lib/aws-iam";
import * as aws_s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";
import { config } from "../utils/config";
import { FILES_BUCKET_NAME } from "../utils/consts";

interface CustomStackProps extends StackProps {
  ecsTaskRole: aws_iam.IRole;
}

export class S3 {
  constructor(scope: Construct, props: CustomStackProps) {
    // Documents bucket
    const filesBucket = new aws_s3.Bucket(scope, `FilesBucket`, {
      bucketName: FILES_BUCKET_NAME,
      versioned: false,
      removalPolicy: RemovalPolicy.DESTROY,
      blockPublicAccess: aws_s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      serverAccessLogsPrefix: `${config.PROJECT_NAME}-files-bucket-access-logs`,
      encryption: aws_s3.BucketEncryption.S3_MANAGED,
      cors: [
        {
          allowedHeaders: ["Authorization"],
          allowedMethods: [aws_s3.HttpMethods.GET],
          allowedOrigins: ["*"],
          exposedHeaders: ["Access-Control-Allow-Origin"],
        },
      ],
    });

    filesBucket.grantReadWrite(props.ecsTaskRole);
  }
}
