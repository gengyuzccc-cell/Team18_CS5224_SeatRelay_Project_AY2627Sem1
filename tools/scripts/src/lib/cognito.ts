import {
  AdminCreateUserCommand,
  AdminSetUserPasswordCommand,
  CognitoIdentityProviderClient,
  UsernameExistsException,
} from '@aws-sdk/client-cognito-identity-provider';
import { networkCause, type FetchLike } from './api';
import {
  assertAwsCredentials,
  awsRegion,
  explainAwsError,
  getStackOutputs,
  requireOutput,
  STACKS,
  type CredentialsBearer,
  type StackOutputsClient,
} from './aws';
import { CliError } from './cli';
import { decodeJwtPayload, jwtExpiresAt } from './jwt';
import type { EnsureUserResult, MintedToken, UserProvider, UserSpec } from './users';

/**
 * Cognito (plan §2.4): accounts are created with `AdminCreateUser` + `MessageAction: SUPPRESS`
 * (no invitation e-mail, so the 50 e-mails/day quota is untouched) and a permanent password
 * (`AdminSetUserPassword`). ID tokens come from `InitiateAuth` (`USER_PASSWORD_AUTH`) on the
 * `tooling` app client, which is a plain HTTPS JSON call without SigV4 signing — exactly what
 * k6 can do too.
 */

export interface CognitoOptions {
  region: string;
  userPoolId: string;
  /** The `tooling` app client (no secret, USER_PASSWORD_AUTH enabled). */
  clientId: string;
  client?: Pick<CognitoIdentityProviderClient, 'send' | 'config'>;
  fetch?: FetchLike;
}

export function cognitoEndpoint(region: string): string {
  return `https://cognito-idp.${region}.amazonaws.com/`;
}

export function cognitoIssuer(region: string, userPoolId: string): string {
  return `https://cognito-idp.${region}.amazonaws.com/${userPoolId}`;
}

interface InitiateAuthResponse {
  AuthenticationResult?: { IdToken?: string; AccessToken?: string; ExpiresIn?: number };
  ChallengeName?: string;
  __type?: string;
  message?: string;
}

/** `InitiateAuth` with `USER_PASSWORD_AUTH`: unsigned JSON POST to the cognito-idp endpoint. */
export async function cognitoInitiateAuth(
  options: CognitoOptions,
  username: string,
  password: string,
): Promise<MintedToken> {
  const fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
  let response: Response;
  try {
    response = await fetchImpl(cognitoEndpoint(options.region), {
      method: 'POST',
      headers: {
        'content-type': 'application/x-amz-json-1.1',
        'x-amz-target': 'AWSCognitoIdentityProviderService.InitiateAuth',
      },
      body: JSON.stringify({
        AuthFlow: 'USER_PASSWORD_AUTH',
        ClientId: options.clientId,
        AuthParameters: { USERNAME: username, PASSWORD: password },
      }),
    });
  } catch (error) {
    throw new CliError(
      `Cognito InitiateAuth for ${username}: ${cognitoEndpoint(options.region)} is not reachable (${networkCause(error)})`,
    );
  }
  const text = await response.text();
  let body: InitiateAuthResponse = {};
  try {
    body = text.length > 0 ? (JSON.parse(text) as InitiateAuthResponse) : {};
  } catch {
    body = { message: text };
  }
  if (!response.ok) {
    throw new Error(
      `Cognito InitiateAuth for ${username} failed: ${response.status} ${body.__type ?? ''} ${body.message ?? text}`.trim(),
    );
  }
  if (body.ChallengeName !== undefined) {
    throw new Error(
      `Cognito InitiateAuth for ${username} returned challenge ${body.ChallengeName}; the account has no permanent password (run create-test-users without --no-create)`,
    );
  }
  const idToken = body.AuthenticationResult?.IdToken;
  if (idToken === undefined) {
    throw new Error(`Cognito InitiateAuth for ${username} returned no IdToken`);
  }
  const payload = decodeJwtPayload(idToken);
  const minted: MintedToken = {
    idToken,
    expiresAt: jwtExpiresAt(idToken, body.AuthenticationResult?.ExpiresIn ?? 3600),
    userId: typeof payload.sub === 'string' ? payload.sub : '',
  };
  if (typeof payload.name === 'string' && payload.name.length > 0) {
    minted.name = payload.name;
  }
  return minted;
}

function clientOf(options: CognitoOptions): Pick<CognitoIdentityProviderClient, 'send' | 'config'> {
  return options.client ?? new CognitoIdentityProviderClient({ region: options.region });
}

/** `AdminCreateUser` (SUPPRESS) + `AdminSetUserPassword` (permanent); `UsernameExistsException` is fine. */
export async function cognitoEnsureUser(
  options: CognitoOptions,
  spec: UserSpec,
): Promise<EnsureUserResult> {
  try {
    return await ensureUserUnchecked(options, spec);
  } catch (error) {
    throw explainAwsError(error, `Cognito AdminCreateUser/AdminSetUserPassword for ${spec.email}`);
  }
}

async function ensureUserUnchecked(
  options: CognitoOptions,
  spec: UserSpec,
): Promise<EnsureUserResult> {
  const client = clientOf(options);
  let created = false;
  let userId: string | undefined;
  try {
    const result = await client.send(
      new AdminCreateUserCommand({
        UserPoolId: options.userPoolId,
        Username: spec.email,
        MessageAction: 'SUPPRESS',
        UserAttributes: [
          { Name: 'email', Value: spec.email },
          { Name: 'email_verified', Value: 'true' },
          ...(spec.name === undefined ? [] : [{ Name: 'name', Value: spec.name }]),
        ],
      }),
    );
    created = true;
    userId = result.User?.Attributes?.find((attribute) => attribute.Name === 'sub')?.Value;
  } catch (error) {
    if (
      !(error instanceof UsernameExistsException) &&
      (error as Error)?.name !== 'UsernameExistsException'
    ) {
      throw error;
    }
  }
  await client.send(
    new AdminSetUserPasswordCommand({
      UserPoolId: options.userPoolId,
      Username: spec.email,
      Password: spec.password,
      Permanent: true,
    }),
  );
  return userId === undefined ? { created } : { userId, created };
}

/**
 * Account creation (`AdminCreateUser` / `AdminSetUserPassword`) is a signed admin call, unlike
 * token minting. Check once, before the first account, that credentials resolve, so a missing
 * configuration fails fast instead of once per user deep inside the SDK.
 */
export const COGNITO_ADMIN_HINT =
  'Creating Cognito accounts (AdminCreateUser / AdminSetUserPassword) needs AWS credentials of ' +
  'the deploying account; only minting tokens for existing accounts needs none.';

export async function assertCognitoAdminCredentials(
  region: string,
  client: CredentialsBearer = new CognitoIdentityProviderClient({ region }),
  hint: string = COGNITO_ADMIN_HINT,
): Promise<void> {
  try {
    await assertAwsCredentials(client);
  } catch (error) {
    if (error instanceof CliError) {
      throw new CliError(error.message, { hint });
    }
    throw error;
  }
}

export function cognitoUserProvider(options: CognitoOptions): UserProvider {
  const resolved: CognitoOptions = { ...options, client: clientOf(options) };
  return {
    kind: 'cognito',
    issuer: cognitoIssuer(options.region, options.userPoolId),
    ensureUser: (spec) => cognitoEnsureUser(resolved, spec),
    mintIdToken: (email, password) => cognitoInitiateAuth(resolved, email, password),
  };
}

export interface ResolveCognitoOptions {
  userPoolId?: string;
  clientId?: string;
  /** Stack whose outputs `UserPoolId` / `ToolingClientId` are read (default seatrelay-auth). */
  authStack?: string;
  region?: string;
  cfnClient?: StackOutputsClient;
  /** Credentials check before the DescribeStacks call (default: the real SDK client). */
  credentialsCheck?: () => Promise<void>;
}

/** Pool and tooling-client ids from flags/env, else from the auth stack's outputs. */
export async function resolveCognitoIds(
  options: ResolveCognitoOptions = {},
): Promise<{ region: string; userPoolId: string; clientId: string; source: 'flags' | 'stack' }> {
  const region = options.region ?? awsRegion();
  const userPoolId = options.userPoolId ?? process.env.COGNITO_USER_POOL_ID;
  const clientId = options.clientId ?? process.env.COGNITO_TOOLING_CLIENT_ID;
  if (userPoolId !== undefined && clientId !== undefined) {
    return { region, userPoolId, clientId, source: 'flags' };
  }
  const stackName = options.authStack ?? STACKS.auth;
  if (options.cfnClient === undefined) {
    await (options.credentialsCheck ?? defaultCredentialsCheck)();
  }
  const outputs = await getStackOutputs(stackName, options.cfnClient);
  return {
    region,
    userPoolId: userPoolId ?? requireOutput(outputs, 'UserPoolId', stackName),
    clientId: clientId ?? requireOutput(outputs, 'ToolingClientId', stackName),
    source: 'stack',
  };
}

async function defaultCredentialsCheck(): Promise<void> {
  const client = new CognitoIdentityProviderClient({ region: awsRegion() });
  try {
    await assertAwsCredentials(client);
  } catch (error) {
    if (error instanceof CliError) {
      throw new CliError(error.message, {
        hint: 'Pass --pool-id and --client-id (and --api / TARGET_API) to skip the CloudFormation lookup, or configure credentials.',
      });
    }
    throw error;
  }
}
