import type { ApiClient } from '@seatrelay/scripts';
import { errorText } from './steps';

/**
 * Raw HTTP probes of the access-control experiment (plan §4 "Access control"): the answer of a
 * request as `<status>[ <CODE>]`, how an expected answer is compared, and a tampered token.
 */

/** `401`, `403 FORBIDDEN`, `200`, … of a raw request. */
export async function statusOf(client: ApiClient, method: string, path: string, body?: unknown): Promise<string> {
  try {
    const response = await client.raw(method, path, body);
    const text = await response.text();
    let code = '';
    try {
      const parsed = JSON.parse(text) as { code?: unknown };
      code = typeof parsed.code === 'string' && !response.ok ? ` ${parsed.code}` : '';
    } catch {
      // CSV or empty body
    }
    return `${response.status}${code}`;
  } catch (error) {
    return `ERROR ${errorText(error)}`;
  }
}

/**
 * `expected` is `<status>` or `<status> <CODE>`; a bare status compares the status only. The 401
 * probes use a bare status: on AWS the HTTP API JWT authorizer rejects the request before the
 * function runs and answers with its own body (`{"message":"Unauthorized"}`).
 */
export function answerMatches(expected: string, actual: string): boolean {
  return expected.includes(' ') ? actual === expected : actual.split(' ')[0] === expected;
}

/** A token whose signature no longer matches (last characters altered). */
export function tamperToken(token: string): string {
  const parts = token.split('.');
  const signature = parts[2] ?? '';
  const flipped = signature.length === 0 ? 'AAAA' : `${signature.slice(0, -4)}${signature.slice(-4) === 'AAAA' ? 'BBBB' : 'AAAA'}`;
  return [parts[0] ?? '', parts[1] ?? '', flipped].join('.');
}
