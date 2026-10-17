import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { CliError } from './cli';

/** Region of every SeatRelay stack (plan §2.4). */
export const DEFAULT_REGION = 'ap-southeast-1';

export function awsRegion(): string {
  return process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? DEFAULT_REGION;
}

export const STACKS = {
  auth: 'seatrelay-auth',
  app: (stage: string): string => `seatrelay-app-${stage}`,
  web: (stage: string): string => `seatrelay-web-${stage}`,
} as const;

export const CREDENTIALS_HINT =
  'No AWS credentials were found. Configure them first (aws configure / AWS_PROFILE / ' +
  'AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY, region ap-southeast-1); nothing was changed.';

/** The subset of an SDK v3 client we need to check that credentials resolve. */
export interface CredentialsBearer {
  config: { credentials?: unknown };
}

/**
 * Resolves the client's credential provider once so that a missing configuration fails fast
 * with a clear message instead of surfacing deep inside the first API call. Offline: the
 * default provider chain only reads the environment, the shared config files and (when
 * configured) the instance metadata endpoint.
 */
export async function assertAwsCredentials(client: CredentialsBearer): Promise<void> {
  const provider = client.config.credentials;
  if (typeof provider !== 'function') {
    throw new CliError(CREDENTIALS_HINT);
  }
  try {
    const identity = (await (provider as () => Promise<unknown>)()) as
      { accessKeyId?: string } | undefined;
    if (identity === undefined || typeof identity.accessKeyId !== 'string') {
      throw new CliError(CREDENTIALS_HINT);
    }
  } catch (error) {
    if (error instanceof CliError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new CliError(`${CREDENTIALS_HINT} (${message})`);
  }
}

/** Error names the SDK uses when credentials are missing, rejected, expired or not allowed. */
const CREDENTIAL_ERROR_NAMES = new Set([
  'CredentialsProviderError',
  'UnrecognizedClientException',
  'InvalidClientTokenId',
  'InvalidSignatureException',
  'SignatureDoesNotMatch',
  'ExpiredToken',
  'ExpiredTokenException',
  'AccessDeniedException',
  'AccessDenied',
  'NotAuthorizedException',
]);

/**
 * Turns an SDK error caused by credentials (missing, rejected, expired or lacking permission)
 * into a `CliError` that names the action; anything else is returned unchanged.
 */
export function explainAwsError(error: unknown, action: string): unknown {
  if (error instanceof CliError) {
    return error;
  }
  const name = error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message : String(error);
  if (
    CREDENTIAL_ERROR_NAMES.has(name) ||
    /could not load credentials|security token|credential|expired token/i.test(message)
  ) {
    const denied = /AccessDenied|NotAuthorized|not authorized/i.test(`${name} ${message}`);
    return new CliError(
      denied
        ? `${action}: the AWS identity is not allowed to do this (${name || 'error'}: ${message})`
        : `${action}: ${CREDENTIALS_HINT} (${name || 'error'}: ${message})`,
    );
  }
  return error;
}

export interface StackOutputsClient {
  send(command: DescribeStacksCommand): Promise<{
    Stacks?: { StackName?: string; Outputs?: { OutputKey?: string; OutputValue?: string }[] }[];
  }>;
}

let defaultCfn: CloudFormationClient | undefined;

export function cloudFormationClient(): CloudFormationClient {
  defaultCfn ??= new CloudFormationClient({ region: awsRegion() });
  return defaultCfn;
}

/** `Outputs` of a CloudFormation stack as `{ OutputKey: OutputValue }`. */
export async function getStackOutputs(
  stackName: string,
  client: StackOutputsClient = cloudFormationClient(),
): Promise<Record<string, string>> {
  let stacks;
  try {
    stacks = (await client.send(new DescribeStacksCommand({ StackName: stackName }))).Stacks;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/does not exist/i.test(message)) {
      throw new CliError(`stack ${stackName} does not exist in ${awsRegion()}`, {
        hint: 'Deploy it first (tools/scripts/bin/deploy-all.sh) or pass the values explicitly.',
      });
    }
    throw explainAwsError(error, `DescribeStacks ${stackName}`);
  }
  const stack = stacks?.[0];
  if (stack === undefined) {
    throw new CliError(`stack ${stackName} not found`);
  }
  const outputs: Record<string, string> = {};
  for (const output of stack.Outputs ?? []) {
    if (output.OutputKey !== undefined && output.OutputValue !== undefined) {
      outputs[output.OutputKey] = output.OutputValue;
    }
  }
  return outputs;
}

export function requireOutput(
  outputs: Record<string, string>,
  key: string,
  stackName: string,
): string {
  const value = outputs[key];
  if (value === undefined || value.length === 0) {
    throw new CliError(`stack ${stackName} has no output ${key}`);
  }
  return value;
}
