import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { MAX_DISPLAY_NAME_LENGTH, type AuthUser } from '@seatrelay/contracts';

/**
 * The API Gateway JWT authorizer has already verified the token (issuer/audience/signature);
 * the identity is read from `event.requestContext.authorizer.jwt.claims` (CONVENTIONS §3):
 * `sub` → userId, `email`, optional `name`. The Cognito ID token carries all three.
 * Returns undefined when the request carried no usable identity (public routes, or a token
 * without `email` such as an access token); routes that require auth then answer 401.
 */
export function userFromEvent(event: APIGatewayProxyEventV2): AuthUser | undefined {
  const requestContext = event.requestContext as {
    authorizer?: { jwt?: { claims?: Record<string, unknown> } };
  };
  const claims = requestContext.authorizer?.jwt?.claims;
  if (claims === undefined || claims === null) {
    return undefined;
  }
  const userId = claimString(claims.sub);
  const email = claimString(claims.email);
  if (userId === undefined || email === undefined) {
    return undefined;
  }
  const user: AuthUser = { userId, email };
  const name = claimString(claims.name);
  if (name !== undefined) {
    user.name = name.slice(0, MAX_DISPLAY_NAME_LENGTH);
  }
  return user;
}

function claimString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}
