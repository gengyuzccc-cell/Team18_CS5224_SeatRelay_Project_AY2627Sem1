import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { MAX_DISPLAY_NAME_LENGTH, type AuthUser } from '@seatrelay/contracts';

/**
 * The API Gateway JWT authorizer has already verified the token (issuer/audience/signature);
 * the identity is read from `event.requestContext.authorizer.jwt.claims` (CONVENTIONS §3):
 * `sub` → userId, `email`, optional `name`. The Cognito ID token carries all three, plus
 * `email_verified`, which must be true: the address is shown to organisers and e-mailed, so an
 * address the user merely typed (Cognito lets a signed-in user change it; the pool now holds
 * the old one until the new one is verified) is never trusted. Returns undefined when the
 * request carried no usable identity (public routes, a token without `email` such as an access
 * token, or an unverified address); routes that require auth then answer 401.
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
  if (userId === undefined || email === undefined || !claimTrue(claims.email_verified)) {
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

/** The authorizer passes claims as strings (`"true"`); a decoded token has the boolean. */
function claimTrue(value: unknown): boolean {
  return value === true || value === 'true';
}
