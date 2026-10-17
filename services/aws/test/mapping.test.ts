import { describe, expect, test } from 'vitest';
import {
  attendanceItem,
  commandResultItem,
  dueMarkerItem,
  entityTypeOf,
  historyBackfillItem,
  historyOfferItem,
  historyRegistrationItem,
  liveOfferItem,
  liveRegistrationItem,
  notificationItem,
  orgMemberItem,
  organizationItem,
  pendingBackfillItem,
  sessionItem,
  toAttendance,
  toBackfillRecord,
  toCommandResult,
  toNotification,
  toOffer,
  toOrganization,
  toRegistration,
  toSession,
  toWorkshop,
  uniqueMarkerItem,
  workshopItem,
} from '../src/adapters/dynamo/mapping';
import {
  T0,
  WS,
  backfill,
  commandResult,
  notification,
  offer,
  organization,
  registration,
  session1,
  workshop,
} from './fixtures';

describe('item mapping', () => {
  test('every item carries entityType and its keys', () => {
    expect(organizationItem(organization)).toMatchObject({
      PK: 'ORG#org-1',
      SK: 'META',
      entityType: 'ORGANIZATION',
    });
    expect(orgMemberItem('org-1', 'alice', T0)).toMatchObject({
      PK: 'ORG#org-1',
      SK: 'M#alice',
      GSI1PK: 'U#alice',
      GSI1SK: 'ORG#org-1',
      entityType: 'ORG_MEMBER',
    });
    expect(workshopItem(workshop)).toMatchObject({
      PK: `WS#${WS}`,
      SK: 'L#META',
      GSI1PK: 'ORG#org-1',
      GSI1SK: `WS#${T0}`,
      entityType: 'WORKSHOP',
    });
    expect(dueMarkerItem(WS, T0)).toEqual({
      PK: `WS#${WS}`,
      SK: 'L#DUE',
      GSI1PK: 'DUE',
      GSI1SK: `${T0}#${WS}`,
      entityType: 'DUE_MARKER',
      workshopId: WS,
      nextDueAt: T0,
    });
    expect(sessionItem(session1)).toMatchObject({
      PK: `WS#${WS}`,
      SK: 'L#S#s1',
      entityType: 'SESSION',
    });
    expect(liveRegistrationItem(registration())).toMatchObject({
      PK: `WS#${WS}`,
      SK: 'L#R#00000001',
      GSI1PK: 'U#bob',
      GSI1SK: `WS#${WS}`,
      entityType: 'REGISTRATION',
    });
    expect(historyRegistrationItem(registration({ status: 'CANCELLED' }))).toMatchObject({
      SK: 'H#R#00000001',
      GSI1PK: 'U#bob',
      entityType: 'REGISTRATION',
      status: 'CANCELLED',
    });
    expect(liveOfferItem(offer())).toMatchObject({ SK: 'L#O#offer-1', entityType: 'OFFER' });
    expect(historyOfferItem(offer({ status: 'EXPIRED' }))).toMatchObject({
      SK: 'H#O#offer-1',
      status: 'EXPIRED',
    });
    expect(pendingBackfillItem(backfill())).toMatchObject({
      SK: `L#BF#${T0}#bf-1`,
      entityType: 'BACKFILL',
    });
    expect(historyBackfillItem(backfill())).toMatchObject({
      SK: `H#BF#${T0}#bf-1`,
      entityType: 'BACKFILL',
    });
    expect(commandResultItem(commandResult())).toMatchObject({
      PK: `CMD#${commandResult().commandId}`,
      SK: 'META',
      entityType: 'COMMAND',
      ttl: 1_000_000,
    });
    expect(notificationItem(notification())).toMatchObject({
      PK: 'U#bob',
      SK: `N#${T0}#n-1`,
      entityType: 'NOTIFICATION',
      ttl: 2_000_000,
    });
    expect(entityTypeOf(notificationItem(notification()))).toBe('NOTIFICATION');
    expect(entityTypeOf({ PK: 'x' })).toBeUndefined();
  });

  test('unique marker is keyed per registration scope', () => {
    const unified = uniqueMarkerItem('UNIFIED', registration());
    expect(unified).toMatchObject({
      SK: 'L#U#bob',
      scope: 'bob',
      seq: 1,
      status: 'QUEUED',
      entityType: 'UNIQUE_MARKER',
    });
    const perSession = uniqueMarkerItem('PER_SESSION', registration({ acceptable: ['s2'] }));
    expect(perSession).toMatchObject({ SK: 'L#U#bob#s2', scope: 'bob#s2' });
  });

  test('round trips strip the key/index attributes and keep every field', () => {
    expect(toOrganization(organizationItem(organization))).toEqual(organization);
    expect(toWorkshop(workshopItem(workshop))).toEqual(workshop);
    expect(toWorkshop(workshopItem({ ...workshop, nextDueAt: T0, status: 'CANCELLING' }))).toEqual({
      ...workshop,
      nextDueAt: T0,
      status: 'CANCELLING',
    });
    expect(toSession(sessionItem(session1))).toEqual(session1);
    const confirmed = registration({ status: 'CONFIRMED', confirmedSessionId: 's1' });
    expect(toRegistration(liveRegistrationItem(confirmed))).toEqual(confirmed);
    const ended = registration({ status: 'ENDED', endReason: 'CUTOFF', acceptable: [] });
    expect(toRegistration(historyRegistrationItem(ended))).toEqual(ended);
    expect(toOffer(liveOfferItem(offer()))).toEqual(offer());
    const settled = offer({ status: 'ACCEPTED', settledAt: T0 });
    expect(toOffer(historyOfferItem(settled))).toEqual(settled);
    const relayed = backfill({
      reallocatedAt: T0,
      newOfferId: 'o2',
      newUserId: 'carol',
      latencyMs: 0,
    });
    expect(toBackfillRecord(historyBackfillItem(relayed))).toEqual(relayed);
    expect(toBackfillRecord(pendingBackfillItem(backfill()))).toEqual(backfill());
    const attendance = {
      workshopId: WS,
      userId: 'bob',
      attended: true,
      markedAt: T0,
      markedBy: 'alice',
    };
    expect(toAttendance(attendanceItem(attendance))).toEqual(attendance);
    const applied = commandResult({
      status: 'APPLIED',
      settledAt: T0,
      result: { offersCreated: 1 },
    });
    expect(toCommandResult(commandResultItem(applied))).toEqual(applied);
    const rejected = commandResult({
      status: 'REJECTED',
      reason: 'ALREADY_REGISTERED',
      settledAt: T0,
    });
    expect(toCommandResult(commandResultItem(rejected))).toEqual(rejected);
    expect(toNotification(notificationItem(notification({ readAt: T0 })))).toEqual(
      notification({ readAt: T0 }),
    );
  });

  test('reading back drops adapter-only attributes and rejects corrupt items', () => {
    const item = { ...notificationItem(notification()), lastError: 'MessageRejected' };
    expect(toNotification(item)).toEqual(notification());
    expect(() => toWorkshop({ ...workshopItem(workshop), status: 'BOGUS' })).toThrow();
  });
});
