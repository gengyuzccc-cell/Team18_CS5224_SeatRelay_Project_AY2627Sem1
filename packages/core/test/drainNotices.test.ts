import { describe, expect, it } from 'vitest';
import { at, cmd, makeSnapshot, registerMany, run } from './helpers';

const range = (from: number, to: number): number[] =>
  Array.from({ length: to - from + 1 }, (_, index) => from + index);

describe('WORKSHOP_CANCELLED notices when the drain spans several decisions', () => {
  it('a PER_SESSION participant with registrations far apart in the queue gets exactly one notice', () => {
    let snapshot = makeSnapshot({
      mode: 'PER_SESSION',
      sessions: [{ id: 'A' }, { id: 'B' }, { id: 'C' }],
    });
    // u1 registers in A, B and C with thirty other participants between each registration, so
    // the budget-sized drain archives u1's three registrations in different decisions.
    const waves: [string, number[]][] = [
      ['A', range(2, 31)],
      ['B', range(32, 61)],
      ['C', range(62, 91)],
    ];
    for (const [session, others] of waves) {
      snapshot = registerMany(snapshot, [1], [session], at(1));
      snapshot = registerMany(snapshot, others, [session], at(1));
    }
    const { decisions, snapshot: after } = run(snapshot, cmd.cancelWorkshop(), at(5));
    expect(decisions.length).toBeGreaterThan(1);
    expect(after.workshop.status).toBe('CANCELLED');
    expect(after.registrations).toEqual([]);

    const perUser = new Map<string, number>();
    for (const decision of decisions) {
      for (const draft of decision.notifications) {
        if (draft.kind === 'WORKSHOP_CANCELLED') {
          perUser.set(draft.userId, (perUser.get(draft.userId) ?? 0) + 1);
        }
      }
    }
    expect(perUser.get('u1')).toBe(1);
    expect(perUser.size).toBe(91);
    expect([...perUser.values()].every((count) => count === 1)).toBe(true);
  });
});
