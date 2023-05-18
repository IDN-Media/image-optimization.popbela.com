// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { Stack, StackProps, RemovalPolicy, aws_s3 as s3, aws_s3_deployment as s3deploy, aws_cloudfront as cloudfront, aws_cloudfront_origins as origins, aws_lambda as lambda, aws_iam as iam, Duration, CfnOutput, aws_logs as logs} from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { MyCustomResource } from './my-custom-resource';
import { createHash } from 'crypto';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import { Certificate } from 'aws-cdk-lib/aws-certificatemanager';
import { ARecord, HostedZone, RecordTarget } from 'aws-cdk-lib/aws-route53';
import { CloudFrontTarget } from 'aws-cdk-lib/aws-route53-targets';

// Stack Parameters

// related to architecture. If set to false, transformed images are not stored in S3, and all image requests land on Lambda
var STORE_TRANSFORMED_IMAGES = 'true';
// Parameters of S3 bucket where original images are stored
var S3_IMAGE_BUCKET_NAME:string;
// CloudFront parameters
var CLOUDFRONT_CORS_ENABLED = 'true';
// Parameters of transformed images
var S3_TRANSFORMED_IMAGE_EXPIRATION_DURATION = '90'; 
var S3_TRANSFORMED_IMAGE_CACHE_TTL = 'max-age=31622400';
// Lambda Parameters
var LAMBDA_MEMORY = '1500';
var LAMBDA_TIMEOUT = '60';
var LOG_TIMING = 'false';

var ZONE_NAME: string;
var RECORD_NAME: string;
var ZONE_ID: string;

type ImageDeliveryCacheBehaviorConfig = {
  origin: any;
  viewerProtocolPolicy: any;
  cachePolicy: any;
  functionAssociations: any;
  responseHeadersPolicy?:any;
};

type LambdaEnv = {
  originalImageBucketName: string,
  transformedImageBucketName?:any;
  transformedImageCacheTTL: string,
  secretKey: string,
  logTiming: string,
}

export class ImageOptimizationStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // Change stack parameters based on provided context
    STORE_TRANSFORMED_IMAGES = this.node.tryGetContext('STORE_TRANSFORMED_IMAGES') || STORE_TRANSFORMED_IMAGES;
    S3_TRANSFORMED_IMAGE_EXPIRATION_DURATION = this.node.tryGetContext('S3_TRANSFORMED_IMAGE_EXPIRATION_DURATION') || S3_TRANSFORMED_IMAGE_EXPIRATION_DURATION; 
    S3_TRANSFORMED_IMAGE_CACHE_TTL = this.node.tryGetContext('S3_TRANSFORMED_IMAGE_CACHE_TTL') || S3_TRANSFORMED_IMAGE_CACHE_TTL;
    S3_IMAGE_BUCKET_NAME = this.node.tryGetContext('S3_IMAGE_BUCKET_NAME') || S3_IMAGE_BUCKET_NAME;
    CLOUDFRONT_CORS_ENABLED = this.node.tryGetContext('CLOUDFRONT_CORS_ENABLED') || CLOUDFRONT_CORS_ENABLED;
    LAMBDA_MEMORY = this.node.tryGetContext('LAMBDA_MEMORY') || LAMBDA_MEMORY;
    LAMBDA_TIMEOUT = this.node.tryGetContext('LAMBDA_TIMEOUT') || LAMBDA_TIMEOUT;
    LOG_TIMING = this.node.tryGetContext('LOG_TIMING') || LOG_TIMING;
    RECORD_NAME = this.node.tryGetContext('RECORD_NAME') || RECORD_NAME;
    ZONE_NAME = this.node.tryGetContext('ZONE_NAME') || ZONE_NAME;
    ZONE_ID = this.node.tryGetContext('ZONE_ID') || ZONE_ID;

    const domainName = `${RECORD_NAME}.${ZONE_NAME}`;

    // Create secret key to be used between CloudFront and Lambda URL for access control
    const SECRET_KEY = createHash('md5').update(this.node.addr).digest('hex') ;

    // For the bucket having original images, either use an external one, or create one with some samples photos.
    var originalImageBucket;
    var transformedImageBucket;
    var sampleWebsiteDelivery;

    if (S3_IMAGE_BUCKET_NAME) {
      originalImageBucket = s3.Bucket.fromBucketName(this,'imported-original-image-bucket', S3_IMAGE_BUCKET_NAME);
      new CfnOutput(this, 'OriginalImagesS3Bucket', {
        description: 'S3 bucket where original images are stored',
        value: originalImageBucket.bucketName
      });  
    } else {
      originalImageBucket = new s3.Bucket(this, 's3-sample-original-image-bucket', {
        removalPolicy: RemovalPolicy.DESTROY,
        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        encryption: s3.BucketEncryption.S3_MANAGED,
        enforceSSL: true,
        autoDeleteObjects: true, 
      });
      new s3deploy.BucketDeployment(this, 'DeployWebsite', {
        sources: [s3deploy.Source.asset('./image-sample')],
        destinationBucket: originalImageBucket,
        destinationKeyPrefix: 'images/rio/',
      });
      var sampleWebsiteBucket = new s3.Bucket(this, 's3-sample-website-bucket', {
        removalPolicy: RemovalPolicy.DESTROY,
        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        encryption: s3.BucketEncryption.S3_MANAGED,
        enforceSSL: true,
        autoDeleteObjects: true, 
      });

      sampleWebsiteDelivery = new cloudfront.Distribution(this, 'websiteDeliveryDistribution', {
        comment: 'image optimization - sample website',
        defaultRootObject: 'index.html',
        defaultBehavior: {
          origin: new origins.S3Origin(sampleWebsiteBucket),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        }
      });
      new CfnOutput(this, 'SampleWebsiteDomain', {
        description: 'Sample website domain',
        value: sampleWebsiteDelivery.distributionDomainName
      });
      new CfnOutput(this, 'SampleWebsiteS3Bucket', {
        description: 'S3 bucket use by the sample website',
        value: sampleWebsiteBucket.bucketName
      });  
      new CfnOutput(this, 'OriginalImagesS3Bucket', {
        description: 'S3 bucket where original images are stored',
        value: originalImageBucket.bucketName
      });  
    }
    
    // create bucket for transformed images if enabled in the architecture
    if (STORE_TRANSFORMED_IMAGES === 'true') {
      transformedImageBucket = new s3.Bucket(this, 's3-transformed-image-bucket', {
        removalPolicy: RemovalPolicy.DESTROY,
        autoDeleteObjects: true, 
        lifecycleRules: [
            {
              expiration: Duration.days(parseInt(S3_TRANSFORMED_IMAGE_EXPIRATION_DURATION)),
            },
          ],
      });
    }

    // prepare env variable for Lambda 
    var lambdaEnv: LambdaEnv = {
      originalImageBucketName: originalImageBucket.bucketName,
      transformedImageCacheTTL: S3_TRANSFORMED_IMAGE_CACHE_TTL,
      secretKey: SECRET_KEY,
      logTiming: LOG_TIMING,
    };
    if (transformedImageBucket) lambdaEnv.transformedImageBucketName = transformedImageBucket.bucketName;

    // IAM policy to read from the S3 bucket containing the original images
    const s3ReadOriginalImagesPolicy = new iam.PolicyStatement({
      actions: ['s3:GetObject'],
      resources: ['arn:aws:s3:::'+originalImageBucket.bucketName+'/*'],
    });
    
    const cloudfrontOAI = new cloudfront.OriginAccessIdentity(
      this, 'CloudFrontOriginAccessIdentity'
    );
    originalImageBucket.addToResourcePolicy(new iam.PolicyStatement({
        actions: ['s3:GetObject'],
        resources: ['arn:aws:s3:::'+originalImageBucket.bucketName+'/*'],
        principals: [new iam.CanonicalUserPrincipal(
            cloudfrontOAI.cloudFrontOriginAccessIdentityS3CanonicalUserId)],
    }));

    // statements of the IAM policy to attach to Lambda
    var iamPolicyStatements = [s3ReadOriginalImagesPolicy];

    // Create Lambda for image processing
    var lambdaProps = {
      runtime: lambda.Runtime.NODEJS_16_X, 
      code: lambda.Code.fromAsset('functions/image-processing'),
      handler: 'index.handler',
      timeout: Duration.seconds(parseInt(LAMBDA_TIMEOUT)),
      memorySize: parseInt(LAMBDA_MEMORY),
      environment: lambdaEnv,
      logRetention: logs.RetentionDays.ONE_DAY,
    };
    var imageProcessing = new lambda.Function(this, 'image-optimization', lambdaProps);

    // Enable Lambda URL
    const imageProcessingURL = imageProcessing.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
    });

    // Leverage a custom resource to get the hostname of the LambdaURL
    const imageProcessingHelper = new MyCustomResource(this, 'customResource', {
      Url: imageProcessingURL.url
    });

    // Create a CloudFront origin: S3 with fallback to Lambda when image needs to be transformed, otherwise with Lambda as sole origin
    var imageOrigin;

    if (transformedImageBucket) {
      imageOrigin = new origins.OriginGroup ({
        primaryOrigin: new origins.S3Origin(transformedImageBucket, { }),
        fallbackOrigin: new origins.HttpOrigin(imageProcessingHelper.hostname, {
          customHeaders: {
            'x-origin-secret-header': SECRET_KEY,
          },
        }), 
        fallbackStatusCodes: [403],
      });

      // write policy for Lambda on the s3 bucket for transformed images
      var s3WriteTransformedImagesPolicy = new iam.PolicyStatement({
        actions: ['s3:PutObject'],
        resources: ['arn:aws:s3:::'+transformedImageBucket.bucketName+'/*'],
      });
      iamPolicyStatements.push(s3WriteTransformedImagesPolicy);
    } else {
      console.log("else transformedImageBucket");
      imageOrigin = new origins.HttpOrigin(imageProcessingHelper.hostname, {
        customHeaders: {
          'x-origin-secret-header': SECRET_KEY,
        },
      });
    }

    // attach iam policy to the role assumed by Lambda
    imageProcessing.role?.attachInlinePolicy(
      new iam.Policy(this, 'read-write-bucket-policy', {
        statements: iamPolicyStatements,
      }),
    );

    // Create a CloudFront Function for url rewrites
    const urlRewriteFunction = new cloudfront.Function(this, 'urlRewrite', {
      code: cloudfront.FunctionCode.fromFile({filePath: 'functions/url-rewrite/index.js',}),
      functionName: `urlRewriteFunction${this.node.addr}`, 
    });

    const cachePolicy = new cloudfront.CachePolicy(this, `ImageCachePolicy${this.node.addr}`, {
      defaultTtl: Duration.hours(24),
      maxTtl: Duration.days(365),
      minTtl: Duration.seconds(30),
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.all()
    });

    var imageDeliveryCacheBehaviorConfig:ImageDeliveryCacheBehaviorConfig  = {
      origin: imageOrigin,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      cachePolicy,
      functionAssociations: [{
        eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
        function: urlRewriteFunction,
      }],
    }

    if (CLOUDFRONT_CORS_ENABLED === 'true') {
      // Creating a custom response headers policy. CORS allowed for all origins.
      const imageResponseHeadersPolicy = new cloudfront.ResponseHeadersPolicy(this, `ResponseHeadersPolicy${this.node.addr}`, {
        responseHeadersPolicyName: 'ImageResponsePolicy',
        corsBehavior: {
          accessControlAllowCredentials: false,
          accessControlAllowHeaders: ['*'],
          accessControlAllowMethods: ['GET'],
          accessControlAllowOrigins: ['*'],
          accessControlMaxAge: Duration.seconds(600),
          originOverride: false,
        },
        // recognizing image requests that were processed by this solution
        customHeadersBehavior: {
          customHeaders: [
            { header: 'x-aws-image-optimization', value: 'v1.0', override: true },
            { header: 'vary', value: 'accept', override: true },
          ],
        }
      });  
      imageDeliveryCacheBehaviorConfig.responseHeadersPolicy = imageResponseHeadersPolicy;
    }

    const certificateUsEastArn = StringParameter.fromStringParameterName(this, 'certificateUsEastArn', '/idn/popbela/certificateUsEastArn').stringValue;
    const certificateUsEast = Certificate.fromCertificateArn(this, "certificateUsEast", certificateUsEastArn);

    const imageDelivery = new cloudfront.Distribution(this, 'imageDeliveryDistribution', {
      comment: 'image optimization - image delivery',
      defaultBehavior: imageDeliveryCacheBehaviorConfig,
      additionalBehaviors: {
        "/*/*/*.svg":{
          origin: new origins.S3Origin(originalImageBucket, {
            originAccessIdentity: cloudfrontOAI
          }),
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy,
        }
      },
      domainNames: [domainName],
      certificate: certificateUsEast,
    });

    const hostedZone = HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
      hostedZoneId: ZONE_ID,
      zoneName: ZONE_NAME,
    });

    new ARecord(this, 'AliasRecord', {
      recordName: RECORD_NAME,
      zone: hostedZone,
      target: RecordTarget.fromAlias(new CloudFrontTarget(imageDelivery)),
    });

    new CfnOutput(this, 'ImageDeliveryDomain', {
      description: 'Domain name of image delivery',
      value: imageDelivery.distributionDomainName
    });
  }
}
