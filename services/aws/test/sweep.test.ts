import { describe, expect, test } from 'vitest';
import { createSweepHandler } from '../src/handlers/sweep';
import { bob, postCommand, scenario } from './harness';

describe('sweep handler', () => {
  test('ticks every workshop whose nextDueAt has passed, once per workshop, with source SWEEP', async () => {
    const { ports, wsId, s1 } = await scenario();
    await postCommand(ports, bob, wsId, { type: 'REGISTER', acceptable: [s1] });
    await ports.drain(); // Bob is offered a seat: nextDueAt = now + 60 s
    const workshop = await ports.store.getWorkshop(wsId);
    expect(workshop?.nextDueAt).toBeDefined();

    const events: string[] = [];
    const handler = createSweepHandler({
      ports: { store: ports.store, queue: ports.queue, clock: ports.clock, logger: ports.logger },
      lifecycle: { begin: () => events.push('begin'), end: () => events.push('end') },
    });

    // Nothing is due yet.
    await expect(handler({}, undefined)).resolves.toEqual({
      now: ports.clock.now(),
      ticked: 0,
      workshopIds: [],
    });
    expect(ports.queue.messages).toEqual([]);

    ports.clock.advanceSeconds(61);
    await expect(handler()).resolves.toEqual({
      now: ports.clock.now(),
      ticked: 1,
      workshopIds: [wsId],
    });
    expect(ports.queue.messages).toEqual([{ type: 'TICK', workshopId: wsId, source: 'SWEEP' }]);
    expect(events).toEqual(['begin', 'end', 'begin', 'end']);

    // The worker then expires the offer; the sweep was late because no timer tick ran.
    await ports.drain();
    expect(ports.metrics.of('OffersExpired')).toContain(1);
    expect(ports.metrics.of('SweepLateExpiries')).toEqual([0]); // within the 60 s grace
    expect((await ports.store.getWorkshop(wsId))?.nextDueAt).toBeUndefined();
  });
});
