import { z } from 'zod';

/** HTTP error codes; every non-2xx API response body is `{ code, message }`. */
export const ERROR_CODES = [
  'VALIDATION_ERROR',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'QUEUE_UNAVAILABLE',
  'INTERNAL',
] as const;
export const ErrorCodeSchema = z.enum(ERROR_CODES);
export type ErrorCode = (typeof ERROR_CODES)[number];

export const ErrorBodySchema = z.object({
  code: ErrorCodeSchema,
  message: z.string(),
});
export type ErrorBody = z.infer<typeof ErrorBodySchema>;

/** Conventional HTTP status for each error code (used by both API adapters). */
export const ERROR_HTTP_STATUS: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  QUEUE_UNAVAILABLE: 503,
  INTERNAL: 500,
};
