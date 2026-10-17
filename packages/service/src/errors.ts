import { ERROR_HTTP_STATUS, type ErrorBody, type ErrorCode } from '@seatrelay/contracts';

/** Thrown by route handlers; mapped to `{ code, message }` with the conventional HTTP status. */
export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;

  constructor(code: ErrorCode, message?: string) {
    super(message ?? defaultMessage(code));
    this.name = 'ApiError';
    this.code = code;
    this.status = ERROR_HTTP_STATUS[code];
  }

  toBody(): ErrorBody {
    return { code: this.code, message: this.message };
  }
}

function defaultMessage(code: ErrorCode): string {
  switch (code) {
    case 'VALIDATION_ERROR':
      return 'Invalid request';
    case 'UNAUTHORIZED':
      return 'Authentication required';
    case 'FORBIDDEN':
      return 'You are not a member of this organisation';
    case 'NOT_FOUND':
      return 'Not found';
    case 'CONFLICT':
      return 'Conflict';
    case 'QUEUE_UNAVAILABLE':
      return 'The command queue is unavailable; please retry';
    case 'INTERNAL':
      return 'Internal error';
  }
}

export const notFound = (what = 'Not found'): ApiError => new ApiError('NOT_FOUND', what);
export const forbidden = (message?: string): ApiError => new ApiError('FORBIDDEN', message);
export const unauthorized = (): ApiError => new ApiError('UNAUTHORIZED');
export const validationError = (message: string): ApiError =>
  new ApiError('VALIDATION_ERROR', message);
