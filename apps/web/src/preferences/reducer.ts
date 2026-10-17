/**
 * Registration form state: the ordered list of acceptable sessionIds (R3 preference order).
 * UNIFIED mode: tick any number and reorder with up/down; PER_SESSION mode: exactly one
 * (`selectOnly`). The engine receives the array as-is (`REGISTER.acceptable`).
 */

export type PreferenceAction =
  | { type: 'toggle'; id: string }
  | { type: 'selectOnly'; id: string }
  | { type: 'moveUp'; id: string }
  | { type: 'moveDown'; id: string }
  | { type: 'remove'; id: string }
  | { type: 'reset'; ids: readonly string[] }
  /** Drop ids that no longer exist (e.g. a session got cancelled while the form was open). */
  | { type: 'prune'; valid: readonly string[] };

export type PreferenceState = readonly string[];

function swap(state: PreferenceState, a: number, b: number): string[] {
  const next = [...state];
  const left = next[a];
  const right = next[b];
  if (left === undefined || right === undefined) {
    return next;
  }
  next[a] = right;
  next[b] = left;
  return next;
}

export function preferenceReducer(state: PreferenceState, action: PreferenceAction): string[] {
  switch (action.type) {
    case 'toggle':
      return state.includes(action.id)
        ? state.filter((id) => id !== action.id)
        : [...state, action.id];
    case 'selectOnly':
      return [action.id];
    case 'remove':
      return state.filter((id) => id !== action.id);
    case 'moveUp': {
      const index = state.indexOf(action.id);
      return index <= 0 ? [...state] : swap(state, index, index - 1);
    }
    case 'moveDown': {
      const index = state.indexOf(action.id);
      return index < 0 || index >= state.length - 1 ? [...state] : swap(state, index, index + 1);
    }
    case 'reset':
      return Array.from(new Set(action.ids));
    case 'prune':
      return state.filter((id) => action.valid.includes(id));
    default:
      return [...state];
  }
}

/** 1-based rank of a session in the preference order, or undefined when not selected. */
export function preferenceRank(state: PreferenceState, id: string): number | undefined {
  const index = state.indexOf(id);
  return index < 0 ? undefined : index + 1;
}
