import {
  CognitoIdentityProviderClient,
  ListUsersCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, test } from 'vitest';
import { CognitoUserDirectory } from '../src/adapters/cognito';

const cognito = mockClient(CognitoIdentityProviderClient);
const directory = new CognitoUserDirectory(new CognitoIdentityProviderClient({}), 'ap-southeast-1_test');

describe('CognitoUserDirectory: e-mail → userId through ListUsers', () => {
  beforeEach(() => cognito.reset());

  test('one exact-match query on the lower-cased address; the sub of the first enabled user', async () => {
    cognito.on(ListUsersCommand).resolves({
      Users: [
        {
          Username: 'f3c1…',
          Enabled: true,
          Attributes: [{ Name: 'sub', Value: '0a1b2c3d-0000-4000-8000-000000000001' }],
        },
      ],
    });
    await expect(directory.findUserIdByEmail('  Walkthrough-Alice@Example.com ')).resolves.toBe(
      '0a1b2c3d-0000-4000-8000-000000000001',
    );
    expect(cognito.commandCalls(ListUsersCommand)).toHaveLength(1);
    expect(cognito.commandCalls(ListUsersCommand)[0]?.args[0].input).toEqual({
      UserPoolId: 'ap-southeast-1_test',
      Filter: 'email = "walkthrough-alice@example.com"',
      Limit: 1,
      AttributesToGet: ['sub'],
    });
  });

  test('no match, a disabled user, or a user without sub: undefined', async () => {
    cognito.on(ListUsersCommand).resolves({ Users: [] });
    await expect(directory.findUserIdByEmail('nobody@example.com')).resolves.toBeUndefined();
    cognito.on(ListUsersCommand).resolves({
      Users: [{ Username: 'x', Enabled: false, Attributes: [{ Name: 'sub', Value: 'u-disabled' }] }],
    });
    await expect(directory.findUserIdByEmail('off@example.com')).resolves.toBeUndefined();
    cognito.on(ListUsersCommand).resolves({ Users: [{ Username: 'x', Enabled: true }] });
    await expect(directory.findUserIdByEmail('nosub@example.com')).resolves.toBeUndefined();
  });

  test('quotes and backslashes cannot break out of the filter; an empty address is not looked up', async () => {
    cognito.on(ListUsersCommand).resolves({ Users: [] });
    await directory.findUserIdByEmail('a"b\\c@example.com');
    expect(cognito.commandCalls(ListUsersCommand)[0]?.args[0].input.Filter).toBe(
      'email = "abc@example.com"',
    );
    await expect(directory.findUserIdByEmail('   ')).resolves.toBeUndefined();
    expect(cognito.commandCalls(ListUsersCommand)).toHaveLength(1);
  });
});
