import { useRef } from 'react';

/**
 * Keys that appeared after the first render that had data (new rows in a polled table), so they
 * can flash once. Rows present on the first load are never "fresh". The returned set only grows;
 * a row keeps its class while it stays, and the CSS animation plays once when it mounts.
 */
export function useArrivals(keys: readonly string[] | undefined): ReadonlySet<string> {
  const seen = useRef<Set<string>>();
  const fresh = useRef(new Set<string>());
  if (keys !== undefined) {
    if (seen.current === undefined) {
      seen.current = new Set(keys);
    } else {
      for (const key of keys) {
        if (!seen.current.has(key)) {
          seen.current.add(key);
          fresh.current.add(key);
        }
      }
    }
  }
  return fresh.current;
}
