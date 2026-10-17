import { randomUUID } from 'node:crypto';
import type { IdGen } from '../ports';

/** Production id generator (CONVENTIONS §2: `node:crypto` `randomUUID()`). */
export const uuidIdGen: IdGen = {
  newId: () => randomUUID(),
};

/** Deterministic ids for tests: `prefix-1`, `prefix-2`, … */
export class SequentialIdGen implements IdGen {
  private counter = 0;

  constructor(private readonly prefix = 'id') {}

  newId(): string {
    this.counter += 1;
    return `${this.prefix}-${this.counter}`;
  }
}
