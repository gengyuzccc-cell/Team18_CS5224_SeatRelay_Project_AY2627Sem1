import type { CreateWorkshopBody, Session, Workshop } from '@seatrelay/contracts';
import { newSession, newWorkshop } from '@seatrelay/core';

export interface NewWorkshopContext {
  now: string;
  newId: () => string;
}

/**
 * `POST /orgs/{orgId}/workshops` (plan §2.2: synchronous REST). Ids from the IdGen, status
 * OPEN, `seq`/`version` 0, `cutoffAt = startsAt − 30 min` via the core factory, sessions in
 * the order given (ids assigned in that order).
 */
export function buildWorkshop(
  body: CreateWorkshopBody,
  orgId: string,
  ctx: NewWorkshopContext,
): { workshop: Workshop; sessions: Session[] } {
  const workshop = newWorkshop({
    id: ctx.newId(),
    orgId,
    title: body.title,
    description: body.description,
    mode: body.mode,
    holdSeconds: body.holdSeconds,
    createdAt: ctx.now,
  });
  const sessions = body.sessions.map((input) =>
    newSession({
      id: ctx.newId(),
      workshopId: workshop.id,
      title: input.title,
      startsAt: input.startsAt,
      capacity: input.capacity,
    }),
  );
  return { workshop, sessions };
}
