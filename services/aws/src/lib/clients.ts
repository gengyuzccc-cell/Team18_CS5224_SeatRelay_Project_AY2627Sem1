import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { SESClient } from '@aws-sdk/client-ses';
import { SQSClient } from '@aws-sdk/client-sqs';
import { lazy } from './runtime';

/** One SDK client per container (created on first use). */
export const documentClient = lazy(() =>
  DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true, convertClassInstanceToMap: false },
    unmarshallOptions: { wrapNumbers: false },
  }),
);

export const sqsClient = lazy(() => new SQSClient({}));

export const sesClient = lazy(() => new SESClient({}));
