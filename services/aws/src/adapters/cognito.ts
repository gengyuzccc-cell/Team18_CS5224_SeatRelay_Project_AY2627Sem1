import {
  ListUsersCommand,
  type CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';
import type { UserDirectory } from '@seatrelay/service';

/**
 * E-mail → userId for `POST /orgs/{orgId}/members` by e-mail (plan §2.5): one `ListUsers` call
 * with an exact-match filter on the pool's `email` attribute (the pool's username attribute is
 * the e-mail, case-insensitive, so the lookup is made on the lower-cased address). Returns the
 * `sub` of the first enabled match, or undefined. Needs `cognito-idp:ListUsers` on the pool.
 */
export class CognitoUserDirectory implements UserDirectory {
  constructor(
    private readonly client: CognitoIdentityProviderClient,
    private readonly userPoolId: string,
  ) {}

  async findUserIdByEmail(email: string): Promise<string | undefined> {
    const value = email.trim().toLowerCase().replace(/["\\]/g, '');
    if (value.length === 0) {
      return undefined;
    }
    const result = await this.client.send(
      new ListUsersCommand({
        UserPoolId: this.userPoolId,
        Filter: `email = "${value}"`,
        Limit: 1,
        AttributesToGet: ['sub'],
      }),
    );
    const user = result.Users?.find((candidate) => candidate.Enabled !== false);
    return user?.Attributes?.find((attribute) => attribute.Name === 'sub')?.Value;
  }
}
