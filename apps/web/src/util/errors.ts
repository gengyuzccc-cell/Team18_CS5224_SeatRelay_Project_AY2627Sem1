import { ApiError } from '../api/client';

const CODE_TEXT: Record<string, string> = {
  VALIDATION_ERROR: 'The server rejected the input',
  UNAUTHORIZED: 'Your session needs to be renewed; sign in again if this message stays',
  FORBIDDEN: 'You are not an organiser of this workshop',
  NOT_FOUND: 'Not found',
  CONFLICT: 'Conflict with an existing request',
  QUEUE_UNAVAILABLE: 'The server could not queue the request right now',
  TOO_MANY_REQUESTS: 'Too many requests right now; please wait a moment and retry',
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
    if (error.code === 'VALIDATION_ERROR') {
      return `${prefix}: ${error.message}`;
    }
    if (error.code === 'NOT_FOUND' || error.code === 'CONFLICT') {
      // The server message already says what was not found or what conflicts.
      return error.message.length > 0 ? error.message : `${prefix}.`;
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
