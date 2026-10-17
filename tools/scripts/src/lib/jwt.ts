export interface JwtPayload {
  sub?: string;
  email?: string;
  name?: string;
  exp?: number;
  iat?: number;
  iss?: string;
  aud?: string | string[];
  [claim: string]: unknown;
}

/** Decodes (without verifying) the payload of a JWT; the API verifies signatures, not we. */
export function decodeJwtPayload(token: string): JwtPayload {
  const parts = token.split('.');
  if (parts.length < 2 || parts[1] === undefined || parts[1].length === 0) {
    throw new Error('not a JWT (expected header.payload.signature)');
  }
  const json = Buffer.from(parts[1], 'base64url').toString('utf8');
  const payload: unknown = JSON.parse(json);
  if (payload === null || typeof payload !== 'object') {
    throw new Error('JWT payload is not an object');
  }
  return payload as JwtPayload;
}

/** `exp` of the token as ISO-8601 UTC; `fallbackSeconds` from now when the claim is missing. */
export function jwtExpiresAt(token: string, fallbackSeconds = 3600, now = Date.now()): string {
  const { exp } = decodeJwtPayload(token);
  const ms = typeof exp === 'number' ? exp * 1000 : now + fallbackSeconds * 1000;
  return new Date(ms).toISOString();
}

/** Builds an unsigned JWT-shaped token for tests and dry runs (`alg: none`). */
export function unsignedJwt(payload: JwtPayload): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(payload)}.`;
}
