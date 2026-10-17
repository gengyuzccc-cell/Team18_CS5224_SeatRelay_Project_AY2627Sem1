import {
  COMMAND_POLL_AFTER_MS,
  CommandBodySchema,
  buildCommand,
  type CommandAcceptedView,
  type CommandResult,
} from '@seatrelay/contracts';
import { acceptedCommandResult } from '../../commands';
import { ApiError, notFound } from '../../errors';
import { commandResultView } from '../../views';
import { isOrganizerCommandType } from '../../worker/processCommand';
import {
  assertOrganiser,
  isOrgMember,
  param,
  requireUser,
  requireWorkshop,
  type ApiRoute,
} from '../context';
import { json, parseBody } from '../http';

/**
 * 202 body of POST /workshops/{wsId}/commands: the `CommandAccepted` fields (plan §1.3) plus
 * the record's current state, so an idempotent re-POST of a settled command already carries
 * its outcome.
 */
export function commandAcceptedView(record: CommandResult): CommandAcceptedView {
  return {
    ...commandResultView(record),
    href: `/commands/${record.commandId}`,
    pollAfterMs: COMMAND_POLL_AFTER_MS,
  };
}

export const commandRoutes: ApiRoute[] = [
  {
    name: 'postCommand',
    method: 'POST',
    pattern: '/workshops/:wsId/commands',
    auth: 'required',
    handler: async (ctx, deps) => {
      const actor = requireUser(ctx);
      const wsId = param(ctx, 'wsId');
      const body = parseBody(CommandBodySchema, ctx.req.body);
      if (!deps.allowFaultFlags) {
        delete body._fault;
      }
      const workshop = await requireWorkshop(deps, wsId);
      if (isOrganizerCommandType(body.type)) {
        await assertOrganiser(deps, workshop, actor.userId); // C7
      }
      const command = buildCommand(body, wsId, actor);
      const record = acceptedCommandResult(command, deps.clock.now());
      const fields = { commandId: command.commandId, workshopId: wsId, type: command.type };

      const put = await deps.store.putCommandAccepted(record);
      if (!put.created) {
        const existing = put.existing;
        if (existing.actorUserId !== actor.userId || existing.workshopId !== wsId) {
          throw new ApiError('CONFLICT', 'commandId is already used by another command');
        }
        deps.logger.info('duplicate command; returning existing record', fields);
        return json(202, commandAcceptedView(existing));
      }
      try {
        await deps.queue.enqueue(command);
      } catch (error) {
        deps.logger.error('enqueue failed; rolling back ACCEPTED record', {
          ...fields,
          error: error instanceof Error ? error.message : String(error),
        });
        await deps.store.deleteCommandIfAccepted(command.commandId);
        throw new ApiError('QUEUE_UNAVAILABLE');
      }
      deps.logger.info('command accepted', fields);
      return json(202, commandAcceptedView(record));
    },
  },
  {
    name: 'getCommand',
    method: 'GET',
    pattern: '/commands/:commandId',
    auth: 'required',
    handler: async (ctx, deps) => {
      const actor = requireUser(ctx);
      const record = await deps.store.getCommandResult(param(ctx, 'commandId'));
      if (record === undefined) {
        throw notFound('Command not found');
      }
      if (record.actorUserId !== actor.userId) {
        // Organisers of the workshop may read it; everyone else learns nothing (404).
        const workshop = await deps.store.getWorkshop(record.workshopId);
        const organization =
          workshop === undefined ? undefined : await deps.store.getOrganization(workshop.orgId);
        if (organization === undefined || !isOrgMember(organization, actor.userId)) {
          throw notFound('Command not found');
        }
      }
      return json(200, commandResultView(record));
    },
  },
];
