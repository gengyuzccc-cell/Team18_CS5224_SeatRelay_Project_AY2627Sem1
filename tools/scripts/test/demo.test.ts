import { describe, expect, it } from 'vitest';
import { ApiClient } from '../src/lib/api';
import { demoParticipants, demoPreferences, seedDemo } from '../src/lib/seedDemo';
import { createInMemoryApi, fakeUserProvider } from './helpers/inMemoryApi';

const FAST = { sleep: async () => undefined };

describe('seedDemo', () => {
  it('parses --participants as a count or an e-mail list', () => {
    expect(demoParticipants('2', 'pw').map((u) => u.email)).toEqual([
      'demo.p1@example.com',
      'demo.p2@example.com',
    ]);
    expect(demoParticipants('a@x.io, b@y.io', 'pw').map((u) => u.email)).toEqual([
      'a@x.io',
      'b@y.io',
    ]);
    expect(demoPreferences(0, ['s1', 's2', 's3'])).toEqual(['s1', 's2', 's3']);
    expect(demoPreferences(1, ['s1', 's2', 's3'])).toEqual(['s2', 's3']);
    expect(demoPreferences(6, ['s1', 's2', 's3'])).toEqual(['s1', 's2', 's3']);
  });

  it('seeds org + 3-session workshop (2/2/1) and registers participants with varied preferences', async () => {
    const api = createInMemoryApi();
    const provider = fakeUserProvider(api);
    const summary = await seedDemo({
      api: new ApiClient({ baseUrl: api.baseUrl, fetch: api.fetch, commandOptions: FAST }),
      provider,
      organiser: { email: 'organiser@example.com', password: 'pw', name: 'Olivia' },
      participants: demoParticipants('4', 'pw'),
      orgName: 'SeatRelay Demo',
      title: 'Demo workshop',
      holdSeconds: 60,
      startsInDays: 3,
      now: Date.parse('2026-10-20T02:00:00.000Z'),
    });
    expect(summary.sessions.map((s) => s.capacity)).toEqual([2, 2, 1]);
    expect(summary.participants.map((p) => [p.status, p.session ?? p.queuePosition])).toEqual([
      ['OFFERED', 'S1'],
      ['OFFERED', 'S2'],
      ['OFFERED', 'S3'],
      ['OFFERED', 'S1'],
    ]);
    expect(summary.verify).toBe(true);
    // after seeding: S1 holds 2 offers, S2 1, S3 1
    expect(summary.sessions.map((s) => [s.key, s.free, s.held])).toEqual([
      ['S1', 0, 2],
      ['S2', 1, 1],
      ['S3', 0, 1],
    ]);
    expect(summary.cancelledWorkshops).toEqual([]);
    const client = new ApiClient({ baseUrl: api.baseUrl, fetch: api.fetch, commandOptions: FAST });
    const view = await client.getWorkshop(summary.workshopId);
    expect(view.sessions.map((s) => s.free)).toEqual([0, 1, 0]);
    expect(view.workshop.holdSeconds).toBe(60);

    // Re-running the preset cancels the earlier demo workshop (same title) and starts clean.
    const again = await seedDemo({
      api: new ApiClient({ baseUrl: api.baseUrl, fetch: api.fetch, commandOptions: FAST }),
      provider,
      organiser: { email: 'organiser@example.com', password: 'pw', name: 'Olivia' },
      participants: demoParticipants('2', 'pw'),
      orgName: 'SeatRelay Demo',
      title: 'Demo workshop',
      holdSeconds: 60,
      startsInDays: 3,
      now: Date.parse('2026-10-20T02:00:00.000Z'),
    });
    expect(again.orgId).toBe(summary.orgId);
    expect(again.cancelledWorkshops.map((w) => w.id)).toEqual([summary.workshopId]);
    expect((await client.getWorkshop(summary.workshopId)).workshop.status).toBe('CANCELLED');
    expect(again.participants.map((p) => p.status)).toEqual(['OFFERED', 'OFFERED']);
  });
});
