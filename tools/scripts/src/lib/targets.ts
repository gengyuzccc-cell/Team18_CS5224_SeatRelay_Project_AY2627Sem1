import { CloudFormationClient } from '@aws-sdk/client-cloudformation';
import type { FetchLike } from './api';
import {
  assertAwsCredentials,
  awsRegion,
  getStackOutputs,
  requireOutput,
  STACKS,
  type StackOutputsClient,
} from './aws';
import { CliError } from './cli';
import { assertCognitoAdminCredentials, cognitoUserProvider, resolveCognitoIds } from './cognito';
import { DEFAULT_KEYCLOAK, keycloakUserProvider, type KeycloakOptions } from './keycloak';
import type { UserProvider } from './users';

/**
 * Where a script talks to: the local compose stack (`local`) or a deployed stage (`dev`,
 * `pilot`). The API base URL comes from `--api` / `TARGET_API`, else from the app stack's
 * `ApiUrl` output (which needs AWS credentials and fails fast without them).
 */

export const TARGETS = ['local', 'dev', 'pilot'] as const;
export type TargetName = (typeof TARGETS)[number];

export const LOCAL_API_BASE = 'http://localhost:3000';

export interface TargetConfig {
  name: TargetName;
  /** `local` for the compose stack, else the stage name. */
  stage: string;
  apiBase: string;
  /** Where `apiBase` came from. */
  apiSource: 'flag' | 'env' | 'default' | 'stack';
}

export interface ResolveTargetOptions {
  target: TargetName;
  api?: string;
  cfnClient?: StackOutputsClient;
  credentialsCheck?: () => Promise<void>;
}

export function parseTarget(value: string | undefined, fallback: TargetName = 'local'): TargetName {
  if (value === undefined) {
    return fallback;
  }
  if (!(TARGETS as readonly string[]).includes(value)) {
    throw new CliError(`unknown target ${value} (expected ${TARGETS.join('|')})`);
  }
  return value as TargetName;
}

export async function resolveTarget(options: ResolveTargetOptions): Promise<TargetConfig> {
  const { target } = options;
  const stage = target;
  if (options.api !== undefined && options.api.length > 0) {
    return { name: target, stage, apiBase: trim(options.api), apiSource: 'flag' };
  }
  const fromEnv = process.env.TARGET_API;
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return { name: target, stage, apiBase: trim(fromEnv), apiSource: 'env' };
  }
  if (target === 'local') {
    return { name: target, stage, apiBase: LOCAL_API_BASE, apiSource: 'default' };
  }
  const stackName = STACKS.app(stage);
  if (options.cfnClient === undefined) {
    await (options.credentialsCheck ?? defaultCredentialsCheck)();
  }
  const outputs = await getStackOutputs(stackName, options.cfnClient);
  return {
    name: target,
    stage,
    apiBase: trim(requireOutput(outputs, 'ApiUrl', stackName)),
    apiSource: 'stack',
  };
}

async function defaultCredentialsCheck(): Promise<void> {
  try {
    await assertAwsCredentials(new CloudFormationClient({ region: awsRegion() }));
  } catch (error) {
    if (error instanceof CliError) {
      throw new CliError(error.message, {
        hint: 'Pass --api <ApiUrl> (or set TARGET_API) to skip the CloudFormation lookup.',
      });
    }
    throw error;
  }
}

function trim(url: string): string {
  return url.replace(/\/+$/, '');
}

export interface ProviderOptions {
  keycloak?: Partial<KeycloakOptions>;
  cognito?: { userPoolId?: string; clientId?: string; authStack?: string };
  fetch?: FetchLike;
  cfnClient?: StackOutputsClient;
  /**
   * Cognito only: check before returning that admin credentials resolve (default true; the
   * seed scripts create accounts). Tests pass false or inject their own check.
   */
  adminCredentialsCheck?: boolean | ((region: string) => Promise<void>);
}

/** Keycloak options for the local stack: defaults, then `KEYCLOAK_*` env, then overrides. */
export function keycloakOptionsFromEnv(overrides: Partial<KeycloakOptions> = {}): KeycloakOptions {
  const env = process.env;
  return {
    ...DEFAULT_KEYCLOAK,
    ...(env.KEYCLOAK_BASE ? { baseUrl: env.KEYCLOAK_BASE } : {}),
    ...(env.KEYCLOAK_REALM ? { realm: env.KEYCLOAK_REALM } : {}),
    ...(env.KEYCLOAK_CLIENT ? { clientId: env.KEYCLOAK_CLIENT } : {}),
    ...(env.KEYCLOAK_ADMIN ? { adminUsername: env.KEYCLOAK_ADMIN } : {}),
    ...(env.KEYCLOAK_ADMIN_PASSWORD ? { adminPassword: env.KEYCLOAK_ADMIN_PASSWORD } : {}),
    ...overrides,
  };
}

/** The identity provider of a target: Keycloak for `local`, the stage's Cognito pool otherwise. */
export async function userProviderFor(
  target: TargetConfig,
  options: ProviderOptions = {},
): Promise<UserProvider> {
  if (target.name === 'local') {
    const keycloak = keycloakOptionsFromEnv({
      ...options.keycloak,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
    return keycloakUserProvider(keycloak);
  }
  const ids = await resolveCognitoIds({
    ...options.cognito,
    ...(options.cfnClient === undefined ? {} : { cfnClient: options.cfnClient }),
  });
  const check = options.adminCredentialsCheck ?? true;
  if (check !== false) {
    await (check === true ? assertCognitoAdminCredentials : check)(ids.region);
  }
  return cognitoUserProvider({
    region: ids.region,
    userPoolId: ids.userPoolId,
    clientId: ids.clientId,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
}
