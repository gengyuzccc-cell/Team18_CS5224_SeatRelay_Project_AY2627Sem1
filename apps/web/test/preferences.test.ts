import { describe, expect, it } from 'vitest';
import { preferenceRank, preferenceReducer } from '../src/preferences/reducer';

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
});
