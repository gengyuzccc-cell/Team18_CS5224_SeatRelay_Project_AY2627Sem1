import { describe, expect, it } from 'vitest';
import {
  describePreferenceChange,
  preferenceRank,
  preferenceReducer,
  type PreferenceAction,
} from '../src/preferences/reducer';

describe('preference-order reducer (R3)', () => {
  it('appends a ticked session at the end and removes it when unticked, keeping the others in order', () => {
    let state = preferenceReducer([], { type: 'toggle', id: 'b' });
    state = preferenceReducer(state, { type: 'toggle', id: 'a' });
    state = preferenceReducer(state, { type: 'toggle', id: 'c' });
    expect(state).toEqual(['b', 'a', 'c']);
    state = preferenceReducer(state, { type: 'toggle', id: 'a' });
    expect(state).toEqual(['b', 'c']);
  });

  it('moves a session up and down one place; the ends are no-ops', () => {
    const base = ['a', 'b', 'c'];
    expect(preferenceReducer(base, { type: 'moveUp', id: 'c' })).toEqual(['a', 'c', 'b']);
    expect(preferenceReducer(base, { type: 'moveDown', id: 'a' })).toEqual(['b', 'a', 'c']);
    expect(preferenceReducer(base, { type: 'moveUp', id: 'a' })).toEqual(base);
    expect(preferenceReducer(base, { type: 'moveDown', id: 'c' })).toEqual(base);
    expect(preferenceReducer(base, { type: 'moveUp', id: 'zzz' })).toEqual(base);
  });

  it('never mutates the previous state', () => {
    const base = ['a', 'b'];
    const next = preferenceReducer(base, { type: 'moveDown', id: 'a' });
    expect(base).toEqual(['a', 'b']);
    expect(next).not.toBe(base);
  });

  it('selectOnly keeps exactly one session (PER_SESSION mode)', () => {
    expect(preferenceReducer(['a', 'b'], { type: 'selectOnly', id: 'c' })).toEqual(['c']);
  });

  it('prune drops sessions that disappeared and reset de-duplicates', () => {
    expect(preferenceReducer(['a', 'b', 'c'], { type: 'prune', valid: ['c', 'a'] })).toEqual([
      'a',
      'c',
    ]);
    expect(preferenceReducer([], { type: 'reset', ids: ['a', 'a', 'b'] })).toEqual(['a', 'b']);
    expect(preferenceReducer(['a', 'b'], { type: 'remove', id: 'a' })).toEqual(['b']);
  });

  it('reports 1-based ranks', () => {
    expect(preferenceRank(['x', 'y'], 'y')).toBe(2);
    expect(preferenceRank(['x', 'y'], 'z')).toBeUndefined();
  });

  it('describes each change for the screen-reader announcement', () => {
    const titles: Record<string, string> = { a: 'Session 1', b: 'Session 2', c: 'Session 3' };
    const titleOf = (id: string) => titles[id] ?? id;
    const say = (state: string[], action: PreferenceAction) =>
      describePreferenceChange(action, preferenceReducer(state, action), titleOf);
    expect(say(['a'], { type: 'toggle', id: 'b' })).toBe('Session 2 added as choice 2 of 2.');
    expect(say(['a', 'b'], { type: 'toggle', id: 'a' })).toBe(
      'Session 1 removed; 1 session chosen.',
    );
    expect(say(['a', 'b', 'c'], { type: 'toggle', id: 'c' })).toBe(
      'Session 3 removed; 2 sessions chosen.',
    );
    expect(say(['a', 'b'], { type: 'moveUp', id: 'b' })).toBe('Session 2 moved to choice 1 of 2.');
    expect(say(['a', 'b', 'c'], { type: 'moveDown', id: 'a' })).toBe(
      'Session 1 moved to choice 2 of 3.',
    );
    expect(say([], { type: 'prune', valid: [] })).toBe('');
  });
});
