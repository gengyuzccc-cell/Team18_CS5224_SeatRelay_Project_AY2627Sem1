import type { AttributeValue, CancellationReason } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import type { Item } from './mapping';

/** `name`-based checks: the SDK exception classes are not always `instanceof`-safe across bundles. */
function errorName(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'name' in error
    ? String((error as { name: unknown }).name)
    : undefined;
}

export function isConditionalCheckFailed(error: unknown): boolean {
  return errorName(error) === 'ConditionalCheckFailedException';
}

export function isTransactionCanceled(error: unknown): boolean {
  return errorName(error) === 'TransactionCanceledException';
}

export const CONDITIONAL_CHECK_FAILED = 'ConditionalCheckFailed';

export function cancellationReasons(error: unknown): CancellationReason[] {
  const reasons = (error as { CancellationReasons?: CancellationReason[] }).CancellationReasons;
  return Array.isArray(reasons) ? reasons : [];
}

export function conditionFailedAt(reasons: readonly CancellationReason[], index: number): boolean {
  return index >= 0 && reasons[index]?.Code === CONDITIONAL_CHECK_FAILED;
}

/** The `Item` attached to a condition failure (`ReturnValuesOnConditionCheckFailure: ALL_OLD`). */
export function conditionFailureItem(error: unknown): Item | undefined {
  const item = (error as { Item?: unknown }).Item;
  if (typeof item !== 'object' || item === null) {
    return undefined;
  }
  return nativeItem(item as Item);
}

const ATTRIBUTE_VALUE_TAGS = new Set(['S', 'N', 'B', 'SS', 'NS', 'BS', 'M', 'L', 'NULL', 'BOOL']);

/**
 * Exception payloads are not translated by the DocumentClient, so an item may still be in
 * AttributeValue form (`{ S: '…' }`). Detects that shape and unmarshalls it; native maps pass.
 */
export function nativeItem(item: Item): Item {
  const values = Object.values(item);
  const looksMarshalled =
    values.length > 0 &&
    values.every((value) => {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return false;
      }
      const keys = Object.keys(value);
      return keys.length === 1 && ATTRIBUTE_VALUE_TAGS.has(keys[0] ?? '');
    });
  return looksMarshalled ? unmarshall(item as Record<string, AttributeValue>) : item;
}
