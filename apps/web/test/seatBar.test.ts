import { describe, expect, it } from 'vitest';
import { seatBarStyle } from '../src/util/seatBar';

const bar = (capacity: number, confirmed: number, held: number) =>
  seatBarStyle({ capacity, confirmed, held }) as Record<string, string>;

describe('seatBarStyle', () => {
  it('confirmed, then confirmed + held, as percentages of capacity', () => {
    expect(bar(4, 1, 1)).toEqual({ '--seat-c': '25.0%', '--seat-h': '50.0%' });
    expect(bar(3, 1, 0)).toEqual({ '--seat-c': '33.3%', '--seat-h': '33.3%' });
  });

  it('an empty session is all free', () => {
    expect(bar(5, 0, 0)).toEqual({ '--seat-c': '0.0%', '--seat-h': '0.0%' });
  });

  it('capacity 0 does not divide by zero', () => {
    expect(bar(0, 0, 0)).toEqual({ '--seat-c': '0%', '--seat-h': '0%' });
    expect(bar(0, 2, 1)).toEqual({ '--seat-c': '0%', '--seat-h': '0%' });
  });

  it('clamps to 100% when seats exceed capacity (capacity lowered below the taken seats)', () => {
    expect(bar(2, 3, 0)).toEqual({ '--seat-c': '100.0%', '--seat-h': '100.0%' });
    expect(bar(2, 1, 2)).toEqual({ '--seat-c': '50.0%', '--seat-h': '100.0%' });
  });
});
