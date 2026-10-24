// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useArrivals } from '../src/util/useArrivals';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let fresh: string[] = [];

function Probe({ keys }: { keys: readonly string[] | undefined }) {
  fresh = [...useArrivals(keys)];
  return null;
}

function render(keys: readonly string[] | undefined): string[] {
  act(() => root.render(<Probe keys={keys} />));
  return fresh;
}

beforeEach(() => {
  root = createRoot(document.createElement('div'));
});
afterEach(() => {
  act(() => root.unmount());
});

describe('useArrivals', () => {
  it('rows present on the first load with data are never fresh', () => {
    expect(render(undefined)).toEqual([]);
    expect(render(['a', 'b'])).toEqual([]);
    expect(render(['a', 'b'])).toEqual([]);
  });

  it('rows that appear after the first load are fresh, and stay so', () => {
    render(['a']);
    expect(render(['a', 'b'])).toEqual(['b']);
    expect(render(['b', 'c'])).toEqual(['b', 'c']);
  });

  it('a row that left and came back is not fresh again', () => {
    render(['a']);
    render([]);
    expect(render(['a'])).toEqual([]);
  });
});
