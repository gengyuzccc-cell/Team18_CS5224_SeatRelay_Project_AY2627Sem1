/**
 * Configuration comes from environment variables only (CONVENTIONS §7). Every variable is
 * documented in the package README; the SAM template (`templates/app.yaml`) sets them.
 */

export function env(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value === '' ? undefined : value;
}

export function requireEnv(name: string): string {
  const value = env(name);
  if (value === undefined) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

/** `'true'` (case-insensitive) is on; anything else, including unset, is off. */
export function envFlag(name: string): boolean {
  return (env(name) ?? '').toLowerCase() === 'true';
}

export function envNumber(name: string, fallback: number): number {
  const raw = env(name);
  if (raw === undefined) {
    return fallback;
  }
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

export const STAGE = (): string => env('STAGE') ?? 'dev';
export const SERVICE_NAME = (): string => env('POWERTOOLS_SERVICE_NAME') ?? 'seatrelay';
