import { z } from 'zod';
import { MAX_SESSIONS_PER_WORKSHOP } from './constants';
import { FaultFlagSchema, TickSourceSchema } from './enums';
import {
  BackfillRecordSchema,
  DisplayNameSchema,
  EmailSchema,
  IdSchema,
  IsoTimestampSchema,
  PositiveIntSchema,
  UuidSchema,
} from './entities';

/**
 * Commands are the only way to change a workshop's live state (plan §2.2).
 *
 * Shape = client fields (`commandId`, `issuedAt?`, `_fault?`) + routing/actor fields injected
 * by the API (`workshopId` from the path, `actorUserId` / `actorEmail` / `actorDisplayName`
 * from the verified JWT) + the type-specific payload. The browser posts a `CommandBody`; the
 * API turns it into a `UserCommand` with `buildCommand()`.
 */

const ClientFields = {
  /** Client-generated UUID v4, reused on retry (idempotency key, C3). */
  commandId: UuidSchema,
  issuedAt: IsoTimestampSchema.optional(),
  _fault: FaultFlagSchema.optional(),
};

const RoutingFields = {
  workshopId: IdSchema,
  actorUserId: IdSchema,
  actorEmail: EmailSchema,
  actorDisplayName: DisplayNameSchema.optional(),
};

/* ---------- payloads (declared once, shared by body and full schemas) ---------- */

const RegisterPayload = {
  /** sessionIds in preference order (R3); PER_SESSION mode requires exactly one. */
  acceptable: z.array(IdSchema).min(1).max(MAX_SESSIONS_PER_WORKSHOP),
};
const OfferPayload = { offerId: IdSchema };
const CancelRegistrationPayload = {
  /** PER_SESSION only: cancel the registration of this session; omitted = all of mine. */
  sessionId: IdSchema.optional(),
};
const SetCapacityPayload = {
  sessionId: IdSchema,
  /** Any integer at the schema level; `< 1` is rejected by the engine (INVALID_CAPACITY). */
  capacity: z.number().int(),
};
const SessionPayload = { sessionId: IdSchema };

/* ---------- what the browser POSTs to /workshops/{wsId}/commands ---------- */

export const RegisterBodySchema = z.object({
  type: z.literal('REGISTER'),
  ...ClientFields,
  ...RegisterPayload,
});
export const AcceptOfferBodySchema = z.object({
  type: z.literal('ACCEPT_OFFER'),
  ...ClientFields,
  ...OfferPayload,
});
export const DeclineOfferBodySchema = z.object({
  type: z.literal('DECLINE_OFFER'),
  ...ClientFields,
  ...OfferPayload,
});
export const CancelRegistrationBodySchema = z.object({
  type: z.literal('CANCEL_REGISTRATION'),
  ...ClientFields,
  ...CancelRegistrationPayload,
});
export const SetCapacityBodySchema = z.object({
  type: z.literal('SET_CAPACITY'),
  ...ClientFields,
  ...SetCapacityPayload,
});
export const CancelSessionBodySchema = z.object({
  type: z.literal('CANCEL_SESSION'),
  ...ClientFields,
  ...SessionPayload,
});
export const CancelWorkshopBodySchema = z.object({
  type: z.literal('CANCEL_WORKSHOP'),
  ...ClientFields,
});
export const CloseRegistrationBodySchema = z.object({
  type: z.literal('CLOSE_REGISTRATION'),
  ...ClientFields,
});
export const OpenRegistrationBodySchema = z.object({
  type: z.literal('OPEN_REGISTRATION'),
  ...ClientFields,
});

export const CommandBodySchema = z.discriminatedUnion('type', [
  RegisterBodySchema,
  AcceptOfferBodySchema,
  DeclineOfferBodySchema,
  CancelRegistrationBodySchema,
  SetCapacityBodySchema,
  CancelSessionBodySchema,
  CancelWorkshopBodySchema,
  CloseRegistrationBodySchema,
  OpenRegistrationBodySchema,
]);
export type CommandBody = z.infer<typeof CommandBodySchema>;

/* ---------- full commands as processed by the worker / engine ---------- */

export const RegisterCommandSchema = RegisterBodySchema.extend(RoutingFields);
export const AcceptOfferCommandSchema = AcceptOfferBodySchema.extend(RoutingFields);
export const DeclineOfferCommandSchema = DeclineOfferBodySchema.extend(RoutingFields);
export const CancelRegistrationCommandSchema = CancelRegistrationBodySchema.extend(RoutingFields);
export const SetCapacityCommandSchema = SetCapacityBodySchema.extend(RoutingFields);
export const CancelSessionCommandSchema = CancelSessionBodySchema.extend(RoutingFields);
export const CancelWorkshopCommandSchema = CancelWorkshopBodySchema.extend(RoutingFields);
export const CloseRegistrationCommandSchema = CloseRegistrationBodySchema.extend(RoutingFields);
export const OpenRegistrationCommandSchema = OpenRegistrationBodySchema.extend(RoutingFields);

/** Internal: run tick-first + allocate. Sent by the expiry forwarder and the sweep. */
export const TickCommandSchema = z.object({
  type: z.literal('TICK'),
  workshopId: IdSchema,
  source: TickSourceSchema.optional(),
  /** Informational only (the engine expires by server time, never by offer id). */
  offerId: IdSchema.optional(),
  expiresAt: IsoTimestampSchema.optional(),
});
/** Internal continuation emitted when a decision hit its per-transaction limits. */
export const ReallocateCommandSchema = z.object({
  type: z.literal('REALLOCATE'),
  workshopId: IdSchema,
});

export const UserCommandSchema = z.discriminatedUnion('type', [
  RegisterCommandSchema,
  AcceptOfferCommandSchema,
  DeclineOfferCommandSchema,
  CancelRegistrationCommandSchema,
  SetCapacityCommandSchema,
  CancelSessionCommandSchema,
  CancelWorkshopCommandSchema,
  CloseRegistrationCommandSchema,
  OpenRegistrationCommandSchema,
]);
export type UserCommand = z.infer<typeof UserCommandSchema>;

export const InternalCommandSchema = z.discriminatedUnion('type', [
  TickCommandSchema,
  ReallocateCommandSchema,
]);
export type InternalCommand = z.infer<typeof InternalCommandSchema>;

export const CommandSchema = z.discriminatedUnion('type', [
  RegisterCommandSchema,
  AcceptOfferCommandSchema,
  DeclineOfferCommandSchema,
  CancelRegistrationCommandSchema,
  SetCapacityCommandSchema,
  CancelSessionCommandSchema,
  CancelWorkshopCommandSchema,
  CloseRegistrationCommandSchema,
  OpenRegistrationCommandSchema,
  TickCommandSchema,
  ReallocateCommandSchema,
]);
export type Command = z.infer<typeof CommandSchema>;

export type RegisterCommand = z.infer<typeof RegisterCommandSchema>;
export type AcceptOfferCommand = z.infer<typeof AcceptOfferCommandSchema>;
export type DeclineOfferCommand = z.infer<typeof DeclineOfferCommandSchema>;
export type CancelRegistrationCommand = z.infer<typeof CancelRegistrationCommandSchema>;
export type SetCapacityCommand = z.infer<typeof SetCapacityCommandSchema>;
export type CancelSessionCommand = z.infer<typeof CancelSessionCommandSchema>;
export type CancelWorkshopCommand = z.infer<typeof CancelWorkshopCommandSchema>;
export type CloseRegistrationCommand = z.infer<typeof CloseRegistrationCommandSchema>;
export type OpenRegistrationCommand = z.infer<typeof OpenRegistrationCommandSchema>;
export type TickCommand = z.infer<typeof TickCommandSchema>;
export type ReallocateCommand = z.infer<typeof ReallocateCommandSchema>;

/** The identity the API extracts from the verified JWT (CONVENTIONS §3). */
export interface AuthUser {
  userId: string;
  email: string;
  name?: string;
}

export function isInternalCommand(command: Command): command is InternalCommand {
  return command.type === 'TICK' || command.type === 'REALLOCATE';
}

export function isUserCommand(command: Command): command is UserCommand {
  return !isInternalCommand(command);
}

/** Injects routing and actor fields into a validated body (never trust the body for these). */
export function buildCommand(body: CommandBody, workshopId: string, actor: AuthUser): UserCommand {
  const command = {
    ...body,
    workshopId,
    actorUserId: actor.userId,
    actorEmail: actor.email,
    ...(actor.name !== undefined ? { actorDisplayName: actor.name } : {}),
  };
  return command as UserCommand;
}
