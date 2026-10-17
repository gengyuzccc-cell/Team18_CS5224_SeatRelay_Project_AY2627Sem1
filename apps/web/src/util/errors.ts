import { ApiError } from '../api/client';

const CODE_TEXT: Record<string, string> = {
  VALIDATION_ERROR: 'The server rejected the input',
  UNAUTHORIZED: 'Your session has expired; please sign in again',
  FORBIDDEN: 'You are not an organiser of this workshop',
  NOT_FOUND: 'Not found',
  CONFLICT: 'Conflict with an existing request',
  QUEUE_UNAVAILABLE: 'The server could not queue the request right now',
  INTERNAL: 'The server hit an internal error',
  NETWORK: 'Could not reach the server',
  INVALID_RESPONSE: 'The server answered in an unexpected format',
};

/** Human-readable one-liner for any thrown value (API `{code,message}` bodies included). */
export function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    const prefix = CODE_TEXT[error.code];
    if (prefix === undefined) {
      return error.message;
    }
    if (
      error.code === 'VALIDATION_ERROR' ||
      error.code === 'NOT_FOUND' ||
      error.code === 'CONFLICT'
    ) {
      return `${prefix}: ${error.message}`;
    }
    return `${prefix}.`;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export function isNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

export function isUnauthorized(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401;
}
