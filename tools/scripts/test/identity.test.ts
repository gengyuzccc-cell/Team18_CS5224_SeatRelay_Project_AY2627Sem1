import {
  AdminCreateUserCommand,
  AdminSetUserPasswordCommand,
  CognitoIdentityProviderClient,
  UsernameExistsException,
} from '@aws-sdk/client-cognito-identity-provider';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, describe, expect, it } from 'vitest';
import type { FetchLike } from '../src/lib/api';
import {
  assertCognitoAdminCredentials,
  cognitoEnsureUser,
  cognitoInitiateAuth,
  cognitoUserProvider,
} from '../src/lib/cognito';
import { decodeJwtPayload, jwtExpiresAt, unsignedJwt } from '../src/lib/jwt';
import {
  DEFAULT_KEYCLOAK,
  KeycloakAdmin,
  keycloakPasswordGrant,
  keycloakUserProvider,
} from '../src/lib/keycloak';
import { generatedUserSpecs, nameFromEmail, provisionUsers, splitName } from '../src/lib/users';

const cognito = mockClient(CognitoIdentityProviderClient);

afterEach(() => {
  cognito.reset();
});

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

describe('jwt helpers', () => {
  it('round-trips an unsigned token and reads exp', () => {
    const token = unsignedJwt({ sub: 'u1', email: 'a@b.c', exp: 1_800_000_000 });
    expect(decodeJwtPayload(token)).toMatchObject({ sub: 'u1', email: 'a@b.c' });
    expect(jwtExpiresAt(token)).toBe('2027-01-15T08:00:00.000Z');
    expect(() => decodeJwtPayload('nope')).toThrow(/JWT/);
  });
});

describe('user specs', () => {
  it('generates prefix-N@domain accounts with readable names', () => {
    const specs = generatedUserSpecs({
      count: 2,
      prefix: 'loaduser',
      domain: 'example.com',
      password: 'p',
    });
    expect(specs.map((s) => s.email)).toEqual(['loaduser-1@example.com', 'loaduser-2@example.com']);
    expect(specs[0]?.name).toBe('Loaduser 1');
    expect(nameFromEmail('study.jordan@example.com')).toBe('Study Jordan');
    expect(splitName('Mei Lin Chua')).toEqual({ firstName: 'Mei Lin', lastName: 'Chua' });
  });
});

describe('Cognito', () => {
  const options = { region: 'ap-southeast-1', userPoolId: 'pool', clientId: 'client' };

  it('creates with SUPPRESS and sets a permanent password; existing users are fine', async () => {
    cognito
      .on(AdminCreateUserCommand, { Username: 'new@example.com' })
      .resolves({ User: { Attributes: [{ Name: 'sub', Value: 'sub-new' }] } })
      .on(AdminCreateUserCommand, { Username: 'old@example.com' })
      .rejects(new UsernameExistsException({ message: 'exists', $metadata: {} }))
      .on(AdminSetUserPasswordCommand)
      .resolves({});
    const client = new CognitoIdentityProviderClient({ region: 'ap-southeast-1' });
    expect(
      await cognitoEnsureUser(
        { ...options, client },
        { email: 'new@example.com', password: 'Pw!12345', name: 'New' },
      ),
    ).toEqual({
      userId: 'sub-new',
      created: true,
    });
    expect(
      await cognitoEnsureUser(
        { ...options, client },
        { email: 'old@example.com', password: 'Pw!12345' },
      ),
    ).toEqual({ created: false });
    const creates = cognito.commandCalls(AdminCreateUserCommand);
    expect(creates[0]?.args[0].input).toMatchObject({
      UserPoolId: 'pool',
      MessageAction: 'SUPPRESS',
      UserAttributes: expect.arrayContaining([
        { Name: 'email', Value: 'new@example.com' },
        { Name: 'email_verified', Value: 'true' },
        { Name: 'name', Value: 'New' },
      ]),
    });
    const passwords = cognito.commandCalls(AdminSetUserPasswordCommand);
    expect(passwords).toHaveLength(2);
    expect(passwords[1]?.args[0].input).toEqual({
      UserPoolId: 'pool',
      Username: 'old@example.com',
      Password: 'Pw!12345',
      Permanent: true,
    });
  });

  it('turns rejected or missing admin credentials into a clear CliError', async () => {
    const rejected = Object.assign(
      new Error('The security token included in the request is invalid.'),
      {
        name: 'UnrecognizedClientException',
      },
    );
    const denied = Object.assign(
      new Error('User is not authorized to perform: cognito-idp:AdminCreateUser'),
      {
        name: 'AccessDeniedException',
      },
    );
    cognito
      .on(AdminCreateUserCommand, { Username: 'a@example.com' })
      .rejects(rejected)
      .on(AdminCreateUserCommand, { Username: 'b@example.com' })
      .rejects(denied)
      .on(AdminCreateUserCommand, { Username: 'c@example.com' })
      .rejects(new Error('socket hang up'));
    const client = new CognitoIdentityProviderClient({ region: 'ap-southeast-1' });
    const ensure = (email: string) =>
      cognitoEnsureUser({ ...options, client }, { email, password: 'Pw!12345' });
    await expect(ensure('a@example.com')).rejects.toMatchObject({
      name: 'CliError',
      message: expect.stringMatching(/AdminCreateUser.*No AWS credentials.*UnrecognizedClient/),
    });
    await expect(ensure('b@example.com')).rejects.toMatchObject({
      name: 'CliError',
      message: expect.stringContaining('not allowed'),
    });
    // Anything that is not about credentials propagates unchanged.
    await expect(ensure('c@example.com')).rejects.toThrow(/^socket hang up$/);
    expect(cognito.commandCalls(AdminSetUserPasswordCommand)).toHaveLength(0);

    await expect(
      assertCognitoAdminCredentials('ap-southeast-1', {
        config: {
          credentials: async () => {
            throw new Error('Could not load credentials from any providers');
          },
        },
      }),
    ).rejects.toMatchObject({ name: 'CliError', hint: expect.stringContaining('--no-create') });
  });

  it('InitiateAuth is an unsigned JSON POST with the X-Amz-Target header', async () => {
    const idToken = unsignedJwt({
      sub: 'sub-1',
      email: 'a@example.com',
      name: 'A',
      exp: 1_900_000_000,
    });
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url, init });
      return jsonResponse(200, { AuthenticationResult: { IdToken: idToken, ExpiresIn: 3600 } });
    };
    const minted = await cognitoInitiateAuth(
      { ...options, fetch: fetchImpl },
      'a@example.com',
      'pw',
    );
    expect(minted).toMatchObject({
      idToken,
      userId: 'sub-1',
      name: 'A',
      expiresAt: new Date(1_900_000_000_000).toISOString(),
    });
    expect(calls[0]?.url).toBe('https://cognito-idp.ap-southeast-1.amazonaws.com/');
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers['x-amz-target']).toBe('AWSCognitoIdentityProviderService.InitiateAuth');
    expect(headers['content-type']).toBe('application/x-amz-json-1.1');
    expect(headers.authorization).toBeUndefined();
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      AuthFlow: 'USER_PASSWORD_AUTH',
      ClientId: 'client',
      AuthParameters: { USERNAME: 'a@example.com', PASSWORD: 'pw' },
    });
  });

  it('reports Cognito errors and challenges clearly', async () => {
    const denied: FetchLike = async () =>
      jsonResponse(400, {
        __type: 'NotAuthorizedException',
        message: 'Incorrect username or password.',
      });
    await expect(
      cognitoInitiateAuth({ ...options, fetch: denied }, 'a@example.com', 'bad'),
    ).rejects.toThrow(/NotAuthorizedException.*Incorrect/);
    const challenge: FetchLike = async () =>
      jsonResponse(200, { ChallengeName: 'NEW_PASSWORD_REQUIRED' });
    await expect(
      cognitoInitiateAuth({ ...options, fetch: challenge }, 'a@example.com', 'pw'),
    ).rejects.toThrow(/NEW_PASSWORD_REQUIRED/);
  });

  it('provisionUsers through the Cognito provider yields token-cache entries', async () => {
    cognito
      .on(AdminCreateUserCommand)
      .resolves({ User: { Attributes: [{ Name: 'sub', Value: 'sub-x' }] } })
      .on(AdminSetUserPasswordCommand)
      .resolves({});
    const fetchImpl: FetchLike = async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { AuthParameters: { USERNAME: string } };
      const token = unsignedJwt({
        sub: `sub-${body.AuthParameters.USERNAME}`,
        email: body.AuthParameters.USERNAME,
        exp: 1_900_000_000,
      });
      return jsonResponse(200, { AuthenticationResult: { IdToken: token } });
    };
    const provider = cognitoUserProvider({
      ...options,
      client: new CognitoIdentityProviderClient({ region: 'ap-southeast-1' }),
      fetch: fetchImpl,
    });
    const users = await provisionUsers(
      provider,
      generatedUserSpecs({ count: 3, prefix: 'u', domain: 'x.io', password: 'p' }),
      { concurrency: 2 },
    );
    expect(users.map((u) => u.email)).toEqual(['u-1@x.io', 'u-2@x.io', 'u-3@x.io']);
    expect(users.every((u) => u.created && u.userId === 'sub-x' && u.idToken.length > 0)).toBe(
      true,
    );
    expect(provider.issuer).toBe('https://cognito-idp.ap-southeast-1.amazonaws.com/pool');
  });
});

describe('Keycloak', () => {
  /** A tiny fake of the token endpoint and the admin users API. */
  function fakeKeycloak() {
    const users = new Map<
      string,
      { id: string; email: string; firstName: string; lastName: string; password: string }
    >();
    const log: string[] = [];
    let nextId = 1;
    const fetchImpl: FetchLike = async (url, init) => {
      const { pathname, searchParams } = new URL(url);
      const method = init?.method ?? 'GET';
      log.push(`${method} ${pathname}`);
      if (method === 'POST' && pathname === '/realms/master/protocol/openid-connect/token') {
        const form = new URLSearchParams(String(init?.body));
        if (form.get('username') !== 'admin' || form.get('password') !== 'admin') {
          return jsonResponse(401, {
            error: 'invalid_grant',
            error_description: 'Invalid user credentials',
          });
        }
        return jsonResponse(200, { access_token: 'admin-token', expires_in: 60 });
      }
      if (method === 'POST' && pathname === '/realms/seatrelay/protocol/openid-connect/token') {
        const form = new URLSearchParams(String(init?.body));
        const user = users.get(form.get('username') ?? '');
        if (user === undefined || user.password !== form.get('password')) {
          return jsonResponse(401, {
            error: 'invalid_grant',
            error_description: 'Invalid user credentials',
          });
        }
        const token = unsignedJwt({
          sub: user.id,
          email: user.email,
          name: `${user.firstName} ${user.lastName}`,
          exp: 1_900_000_000,
        });
        return jsonResponse(200, {
          access_token: 'x',
          id_token: form.get('scope') === 'openid' ? token : undefined,
          expires_in: 3600,
        });
      }
      const auth = (init?.headers as Record<string, string>)?.authorization;
      if (auth !== 'Bearer admin-token') {
        return jsonResponse(401, { error: 'unauthorized' });
      }
      if (method === 'GET' && pathname === '/admin/realms/seatrelay/users') {
        const email = searchParams.get('email') ?? '';
        const found = [...users.values()].filter((u) => u.email === email);
        return jsonResponse(
          200,
          found.map(({ password: _p, ...rest }) => rest),
        );
      }
      if (method === 'POST' && pathname === '/admin/realms/seatrelay/users') {
        const body = JSON.parse(String(init?.body)) as {
          email: string;
          firstName: string;
          lastName: string;
          credentials: { value: string }[];
        };
        if (users.has(body.email)) {
          return jsonResponse(409, { errorMessage: 'User exists with same email' });
        }
        const id = `kc-${nextId++}`;
        users.set(body.email, {
          id,
          email: body.email,
          firstName: body.firstName,
          lastName: body.lastName,
          password: body.credentials[0]?.value ?? '',
        });
        return new Response(null, {
          status: 201,
          headers: { location: `http://kc/admin/realms/seatrelay/users/${id}` },
        });
      }
      const reset = /^\/admin\/realms\/seatrelay\/users\/([^/]+)\/reset-password$/.exec(pathname);
      if (method === 'PUT' && reset !== null) {
        const user = [...users.values()].find((u) => u.id === reset[1]);
        if (user !== undefined) {
          user.password = (JSON.parse(String(init?.body)) as { value: string }).value;
        }
        return new Response(null, { status: 204 });
      }
      return jsonResponse(404, { error: `unhandled ${method} ${pathname}` });
    };
    return { users, log, fetchImpl };
  }

  it('creates missing accounts, resets passwords of existing ones and mints ID tokens', async () => {
    const kc = fakeKeycloak();
    const options = { ...DEFAULT_KEYCLOAK, baseUrl: 'http://kc', fetch: kc.fetchImpl };
    const admin = new KeycloakAdmin(options);
    expect(
      await admin.ensureUser({ email: 'new@example.com', password: 'pw1', name: 'Mei Lin Chua' }),
    ).toEqual({ userId: 'kc-1', created: true });
    expect(kc.users.get('new@example.com')).toMatchObject({
      firstName: 'Mei Lin',
      lastName: 'Chua',
      password: 'pw1',
    });
    expect(await admin.ensureUser({ email: 'new@example.com', password: 'pw2' })).toEqual({
      userId: 'kc-1',
      created: false,
    });
    expect(kc.users.get('new@example.com')?.password).toBe('pw2');
    expect(kc.log.filter((line) => line.includes('/realms/master/'))).toHaveLength(1); // admin token cached

    const minted = await keycloakPasswordGrant(options, 'new@example.com', 'pw2');
    expect(minted).toMatchObject({ userId: 'kc-1', name: 'Mei Lin Chua' });
    await expect(keycloakPasswordGrant(options, 'new@example.com', 'wrong')).rejects.toThrow(
      /Invalid user credentials/,
    );

    const provider = keycloakUserProvider(options);
    expect(provider.issuer).toBe('http://kc/realms/seatrelay');
    const users = await provisionUsers(provider, [
      { email: 'a@example.com', password: 'p' },
      { email: 'b@example.com', password: 'p' },
    ]);
    expect(users.map((u) => [u.email, u.userId, u.created])).toEqual([
      ['a@example.com', 'kc-2', true],
      ['b@example.com', 'kc-3', true],
    ]);
    const tokensOnly = await provisionUsers(provider, [{ email: 'a@example.com', password: 'p' }], {
      create: false,
    });
    expect(tokensOnly[0]?.created).toBe(false);
  });

  it('reports a wrong admin password clearly', async () => {
    const kc = fakeKeycloak();
    const admin = new KeycloakAdmin({
      ...DEFAULT_KEYCLOAK,
      baseUrl: 'http://kc',
      adminPassword: 'nope',
      fetch: kc.fetchImpl,
    });
    await expect(admin.ensureUser({ email: 'x@example.com', password: 'p' })).rejects.toThrow(
      /Invalid user credentials/,
    );
  });
});
