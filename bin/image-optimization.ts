#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { ImageOptimizationStack } from '../lib/image-optimization-stack';

const app = new cdk.App();

const environment = app.node.tryGetContext('ENV');

const stack = new ImageOptimizationStack(app, 'ImgTransformationStack', {
});

cdk.Tags.of(stack).add('Project', 'Popbela');
cdk.Tags.of(stack).add('Environment', environment);
