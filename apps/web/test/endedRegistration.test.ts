import { describe, expect, it } from 'vitest';
import {
  latestEndedRegistration,
  listBehindWorkshopView,
  needsCatchUp,
} from '../src/api/endedRegistration';
import { at, cancelled, confirmed, list, listed, summary, workshop, WS } from './fixtures';

const ended = summary({
  status: 'ENDED',
  seq: 2,
  queuePosition: undefined,
  acceptable: [],
  endReason: 'NO_ACCEPTABLE_SESSION',
});
const otherWorkshop = (entry: ReturnType<typeof listed>) => ({
  ...entry,
  workshop: { ...workshop, id: 'ws-2' },
});

describe('latestEndedRegistration (workshop page)', () => {
  it('explains the most recent ended registration of this workshop when nothing is live', () => {
    const older = listed({ ...cancelled, seq: 1 }, at(10));
    const latest = listed(ended, at(50), at(20));
    const elsewhere = otherWorkshop(listed({ ...ended, seq: 9 }, at(90)));
    expect(latestEndedRegistration(list(elsewhere, latest, older), WS, undefined, 'UNIFIED')).toBe(
      latest,
    );
    expect(latestEndedRegistration(list(elsewhere), WS, undefined, 'UNIFIED')).toBeUndefined();
    expect(latestEndedRegistration(undefined, WS, undefined, 'UNIFIED')).toBeUndefined();
  });

  it('disappears once the participant registered again', () => {
    const before = listed(ended, at(50), at(20));
    const again = listed(summary({ seq: 3 }), at(60), at(60));
    // UNIFIED: a live `me` always wins
    expect(latestEndedRegistration(list(before), WS, summary({ seq: 3 }), 'UNIFIED')).toBe(
      undefined,
    );
    // a live registration created after the ending (e.g. PER_SESSION, or the list ahead of the view)
    expect(latestEndedRegistration(list(again, before), WS, undefined, 'PER_SESSION')).toBe(
      undefined,
    );
  });

  it('PER_SESSION: an ending after the live registration of another session is still shown', () => {
    const live = listed({ ...confirmed, seq: 1 }, at(5), at(1));
    const endedLater = listed(ended, at(50), at(2));
    expect(
      latestEndedRegistration(list(endedLater, live), WS, { ...confirmed, seq: 1 }, 'PER_SESSION'),
    ).toBe(endedLater);
  });

  it('a stale live copy (list behind) never brings back an older ending', () => {
    // cancelled at +10, registered again at +20 (seq 2), that one ended — but the list still
    // shows it live: nothing is explained until the list catches up
    const old = listed({ ...cancelled, seq: 1 }, at(10));
    const staleLive = listed(summary({ seq: 2, status: 'OFFERED' }), at(25), at(20));
    const stale = list(staleLive, old);
    expect(latestEndedRegistration(stale, WS, undefined, 'UNIFIED')).toBeUndefined();
    expect(listBehindWorkshopView(stale, WS, undefined, 'UNIFIED')).toBe(true);
    // caught up: the archived copy is listed
    const caughtUp = list(listed(ended, at(30), at(20)), old);
    expect(latestEndedRegistration(caughtUp, WS, undefined, 'UNIFIED')?.registration.seq).toBe(2);
    expect(listBehindWorkshopView(caughtUp, WS, undefined, 'UNIFIED')).toBe(false);
  });

  it('listBehindWorkshopView only applies to UNIFIED without a live `me`', () => {
    const live = list(listed(summary(), at(5)));
    expect(listBehindWorkshopView(live, WS, summary(), 'UNIFIED')).toBe(false);
    expect(listBehindWorkshopView(live, WS, undefined, 'PER_SESSION')).toBe(false);
    expect(listBehindWorkshopView(undefined, WS, undefined, 'UNIFIED')).toBe(false);
  });

  it('needsCatchUp also while the ended card only has the poll result (no ending yet)', () => {
    const fromPoll = listed(ended, at(50), at(20));
    expect(needsCatchUp(list(fromPoll), WS, undefined, 'UNIFIED')).toBe(true);
    const fromServer = listed(ended, at(50), at(20));
    fromServer.registration.ending = {};
    expect(needsCatchUp(list(fromServer), WS, undefined, 'UNIFIED')).toBe(false);
    expect(needsCatchUp(list(listed(summary(), at(5))), WS, undefined, 'UNIFIED')).toBe(true);
    expect(needsCatchUp(list(), WS, undefined, 'UNIFIED')).toBe(false);
  });

  it('a list that has dropped the registration last seen live is behind until it lists it as ended', () => {
    // seq 1 ended last week; seq 3 (seen live on the page) just ended, but the index lists
    // neither its live nor its archived copy yet
    const older = listed({ ...cancelled, seq: 1 }, at(10));
    older.registration.ending = {};
    const dropped = list(older);
    expect(listBehindWorkshopView(dropped, WS, undefined, 'UNIFIED')).toBe(false);
    expect(listBehindWorkshopView(dropped, WS, undefined, 'UNIFIED', 3)).toBe(true);
    expect(needsCatchUp(dropped, WS, undefined, 'UNIFIED', 3)).toBe(true);
    // the archived copy arrived
    const caughtUp = list(listed({ ...ended, seq: 3 }, at(50), at(20)), older);
    expect(listBehindWorkshopView(caughtUp, WS, undefined, 'UNIFIED', 3)).toBe(false);
    // only while the workshop view has no live `me`, and only in UNIFIED mode
    expect(listBehindWorkshopView(dropped, WS, summary({ seq: 4 }), 'UNIFIED', 3)).toBe(false);
    expect(listBehindWorkshopView(dropped, WS, undefined, 'PER_SESSION', 3)).toBe(false);
  });
});
