import {
  EmailSchema,
  IdSchema,
  MAX_DISPLAY_NAME_LENGTH,
  type AuthUser,
} from '@seatrelay/contracts';
import { createRemoteJWKSet, errors as joseErrors, jwtVerify, type JWTPayload } from 'jose';

/** Thrown for a missing or invalid bearer token; the server answers 401 `{ code: 'UNAUTHORIZED' }`. */
export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

export interface TokenVerifierOptions {
  /** Expected `iss` (plan §2.7: the browser-visible issuer, e.g. http://localhost:8080/realms/seatrelay). */
  issuer: string;
  /** JWKS endpoint reachable from the server (inside compose: http://keycloak:8080/...). */
  jwksUrl: string;
  /** Accepted `aud` values (client ids: seatrelay-web, tooling). */
  audience: readonly string[];
  /** Clock skew tolerance in seconds. */
  clockToleranceSeconds?: number;
}

export interface TokenVerifier {
  verify(token: string): Promise<AuthUser>;
}

/**
 * Verifies an RS256 ID token against the issuer's JWKS (`createRemoteJWKSet` caches the keys
 * and refreshes on an unknown `kid`), checks `iss`, `aud` and `exp`, and maps the claims to
 * `AuthUser { userId = sub, email, name? }` (CONVENTIONS §3).
 */
export function createTokenVerifier(options: TokenVerifierOptions): TokenVerifier {
  const jwks = createRemoteJWKSet(new URL(options.jwksUrl), {
    cooldownDuration: 30_000,
    cacheMaxAge: 10 * 60_000,
  });
  const audience = [...options.audience];
  return {
    async verify(token: string): Promise<AuthUser> {
      let payload: JWTPayload;
      try {
        const verified = await jwtVerify(token, jwks, {
          issuer: options.issuer,
          ...(audience.length > 0 ? { audience } : {}),
          algorithms: ['RS256'],
          clockTolerance: options.clockToleranceSeconds ?? 60,
        });
        payload = verified.payload;
      } catch (error) {
        throw new AuthError(describeJoseError(error));
      }
      return toAuthUser(payload);
    },
  };
}

/**
 * Maps verified claims to the identity every command carries. The values must satisfy the
 * command schema the worker validates (`actorUserId`, `actorEmail`, `actorDisplayName`):
 * a token the API accepted but whose command the worker refuses would leave that command
 * ACCEPTED forever. So `email` must be a valid address (`preferred_username` is used only when
 * it is one, e.g. Keycloak with registrationEmailAsUsername), otherwise the token is refused
 * (401), and the display name is truncated like the cloud adapter does.
 */
export function toAuthUser(payload: JWTPayload): AuthUser {
  const sub = typeof payload.sub === 'string' ? payload.sub : undefined;
  if (sub === undefined || sub.length === 0) {
    throw new AuthError('token has no subject');
  }
  if (!IdSchema.safeParse(sub).success) {
    throw new AuthError('token subject invalid');
  }
  const email = [stringClaim(payload, 'email'), stringClaim(payload, 'preferred_username')].find(
    (candidate) => candidate !== undefined && EmailSchema.safeParse(candidate).success,
  );
  if (email === undefined) {
    throw new AuthError('token has no valid email claim');
  }
  const name = (
    stringClaim(payload, 'name') ??
    [stringClaim(payload, 'given_name'), stringClaim(payload, 'family_name')]
      .filter((part) => part !== undefined)
      .join(' ')
  )
    .slice(0, MAX_DISPLAY_NAME_LENGTH)
    .trim();
  const user: AuthUser = { userId: sub, email };
  if (name.length > 0) {
    user.name = name;
  }
  return user;
}

function stringClaim(payload: JWTPayload, claim: string): string | undefined {
  const value = payload[claim];
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function describeJoseError(error: unknown): string {
  if (error instanceof joseErrors.JWTExpired) {
    return 'token expired';
  }
  if (error instanceof joseErrors.JWTClaimValidationFailed) {
    return `token claim invalid: ${error.claim}`;
  }
  if (error instanceof joseErrors.JWSSignatureVerificationFailed) {
    return 'token signature invalid';
  }
  if (error instanceof joseErrors.JOSEError) {
    return `token invalid: ${error.code}`;
  }
  return error instanceof Error ? `token verification failed: ${error.message}` : 'token invalid';
}

/** Extracts the bearer token of an `Authorization` header, if any. */
export function bearerToken(header: string | undefined): string | undefined {
  if (header === undefined) {
    return undefined;
  }
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || undefined;
}
