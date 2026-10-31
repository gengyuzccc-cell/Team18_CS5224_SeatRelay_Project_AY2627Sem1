import { describe, expect, it } from 'vitest';
import { ApiClient, expectApplied } from '../src/lib/api';
import {
  BACKFILL_CSV_COLUMNS,
  backfillRows,
  backfillsCsv,
  backfillsFileName,
  exportBackfills,
} from '../src/lib/backfills';
import { createInMemoryApi } from './helpers/inMemoryApi';

const ORGANISER = { userId: 'org-1', email: 'organiser@example.com', name: 'Olivia Organiser' };
const ALICE = { userId: 'alice-1', email: 'alice@example.com', name: 'Alice' };
const BOB = { userId: 'bob-1', email: 'bob@example.com', name: 'Bob' };
const FAST = { sleep: async () => undefined };

/** The header line the pilot rehearsal writes (tools/experiments/src/pilot-rehearsal.ts). */
const REHEARSAL_HEADER =
  'cause,session,releasedAt,reallocatedAt,latencyMs,recomputedMs,newParticipant,backfillId';

describe('backfillsCsv', () => {
  it('writes the rehearsal columns, RFC 4180 quoting and \\n line ends', () => {
    expect(BACKFILL_CSV_COLUMNS.join(',')).toBe(REHEARSAL_HEADER);
    const csv = backfillsCsv([
      {
        cause: 'EXPIRED',
        session: 'S1',
        releasedAt: '2026-11-10T02:00:00.000Z',
        reallocatedAt: '',
        latencyMs: '',
        recomputedMs: '',
        newParticipant: '',
        backfillId: 'b-1',
      },
      {
        cause: 'DECLINED',
        session: 'S "two"',
        releasedAt: '2026-11-10T02:00:01.000Z',
        reallocatedAt: '2026-11-10T02:00:01.074Z',
        latencyMs: 74,
        recomputedMs: 74,
        newParticipant: 'user,9',
        backfillId: 'b-2',
      },
    ]);
    expect(csv).toBe(
      `${REHEARSAL_HEADER}\n` +
        'EXPIRED,S1,2026-11-10T02:00:00.000Z,,,,,b-1\n' +
        'DECLINED,"S ""two""",2026-11-10T02:00:01.000Z,2026-11-10T02:00:01.074Z,74,74,"user,9",b-2\n',
    );
    expect(backfillsCsv([])).toBe(`${REHEARSAL_HEADER}\n`);
    expect(backfillsFileName('ws-1')).toBe('backfills-ws-1.csv');
  });
});

describe('exportBackfills', () => {
  it('renders the dashboard backfill log of a workshop (session label, opaque user id)', async () => {
    const api = createInMemoryApi();
    const anonymous = new ApiClient({
      baseUrl: api.baseUrl,
      fetch: api.fetch,
      commandOptions: FAST,
    });
    const organiser = anonymous.withToken(api.tokenFor(ORGANISER));
    const alice = anonymous.withToken(api.tokenFor(ALICE));
    const bob = anonymous.withToken(api.tokenFor(BOB));
    const org = await organiser.createOrg('Pilot org');
    const created = await organiser.createWorkshop(org.id, {
      title: 'Pilot workshop',
      holdSeconds: 60,
      sessions: [
        { title: 'Morning', startsAt: '2026-11-10T02:00:00.000Z', capacity: 1 },
        { title: 'Afternoon', startsAt: '2026-11-10T06:00:00.000Z', capacity: 1 },
      ],
    });
    const wsId = created.workshop.id;
    const [s1, s2] = created.sessions.map((session) => session.id) as [string, string];

    // Alice holds S1, Bob queues for S1 only, Alice declines: the seat is relayed to Bob.
    const registered = expectApplied(
      await alice.sendCommand(wsId, { type: 'REGISTER', acceptable: [s1] }),
      'alice REGISTER',
    );
    const offerId = registered.record.result?.registration?.currentOffer?.id;
    expect(offerId).toBeDefined();
    expectApplied(await bob.sendCommand(wsId, { type: 'REGISTER', acceptable: [s1] }), 'bob');
    expectApplied(
      await alice.sendCommand(wsId, { type: 'DECLINE_OFFER', offerId: offerId as string }),
      'alice DECLINE_OFFER',
    );
    expect((await organiser.dashboard(org.id, wsId)).sessions.map((s) => s.id)).toEqual([s1, s2]);

    const exported = await exportBackfills(organiser, org.id, wsId);
    expect(exported.title).toBe('Pilot workshop');
    expect(exported.rows).toHaveLength(1);
    const [row] = exported.rows as [(typeof exported.rows)[number]];
    expect(row.cause).toBe('DECLINED');
    expect(row.session).toBe('S1');
    expect(row.newParticipant).toBe(BOB.userId);
    expect(row.reallocatedAt).not.toBe('');
    expect(row.recomputedMs).toBe(
      Date.parse(String(row.reallocatedAt)) - Date.parse(row.releasedAt as string),
    );
    expect(row.latencyMs).toBe(row.recomputedMs);
    expect(String(row.backfillId).length).toBeGreaterThan(0);
    const lines = exported.csv.split('\n');
    expect(lines[0]).toBe(REHEARSAL_HEADER);
    expect(lines[1]).toBe(
      `DECLINED,S1,${row.releasedAt},${row.reallocatedAt},${row.latencyMs},${row.recomputedMs},${BOB.userId},${row.backfillId}`,
    );
    expect(lines).toHaveLength(3);
    expect(exported.csv).not.toContain('@example.com');

    // backfillRows keeps a session the dashboard no longer lists by its id.
    const dashboard = await organiser.dashboard(org.id, wsId);
    const rows = backfillRows({ ...dashboard, sessions: [] });
    expect(rows[0]?.session).toBe(s1);
  });
});
