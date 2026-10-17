import type {
  RegistrationSummary,
  SessionView,
  WorkshopMode,
  WorkshopPublic,
} from '@seatrelay/contracts';
import { useState } from 'react';
import { useCommand } from '../commands/useCommand';
import { END_REASON_TEXT, sessionTitle } from '../commands/copy';
import { describeError } from '../util/errors';
import { formatDateTime } from '../util/time';
import { AsyncButton, type AsyncState } from './AsyncButton';
import { Countdown } from './Countdown';
import { isCancelledLike, StatusBadge } from './StatusBadge';

interface Props {
  workshop: WorkshopPublic;
  sessions: readonly SessionView[];
  registration: RegistrationSummary;
  /** Called when a command settles or an offer countdown hits zero (refetch the view). */
  onChanged?: () => void;
  compact?: boolean;
}

function stateOf(phase: string, active: boolean): AsyncState {
  if (!active) {
    return 'idle';
  }
  if (phase === 'submitting' || phase === 'processing') {
    return 'pending';
  }
  if (phase === 'applied') {
    return 'done';
  }
  if (phase === 'error') {
    return 'error';
  }
  return 'idle';
}

/**
 * "My status" card (plan §2.6): Queued position N / Offered with live countdown + Accept /
 * Decline / Confirmed session + Cancel / Ended reason. Every action goes through the 202 +
 * polling flow and reports idle / pending / done + error copy.
 */
export function StatusCard({
  workshop,
  sessions,
  registration,
  onChanged,
  compact = false,
}: Props) {
  const command = useCommand(workshop.id, { sessions, onSettled: onChanged });
  const [active, setActive] = useState<'accept' | 'decline' | 'cancel' | undefined>(undefined);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const mode: WorkshopMode = workshop.mode;
  const workshopClosed = isCancelledLike(workshop.status);
  const offer = registration.currentOffer;
  const offeredSession =
    offer === undefined ? undefined : sessions.find((s) => s.id === offer.sessionId);

  const act = (kind: 'accept' | 'decline' | 'cancel') => {
    setActive(kind);
    setConfirmCancel(false);
    if (kind === 'accept' && offer !== undefined) {
      void command.run({ type: 'ACCEPT_OFFER', offerId: offer.id });
    } else if (kind === 'decline' && offer !== undefined) {
      void command.run({ type: 'DECLINE_OFFER', offerId: offer.id });
    } else if (kind === 'cancel') {
      const sessionId = mode === 'PER_SESSION' ? registration.acceptable[0] : undefined;
      void command.run({
        type: 'CANCEL_REGISTRATION',
        ...(sessionId !== undefined ? { sessionId } : {}),
      });
    }
  };

  const phase = command.state.phase;
  const processing = command.state.phase === 'processing';
  const slow = command.state.phase === 'processing' && command.state.slow;

  return (
    <section
      className={`card status-card status-${registration.status.toLowerCase()}`}
      aria-live="polite"
    >
      <header className="card-header">
        <h3>{compact ? workshop.title : 'My status'}</h3>
        <StatusBadge status={registration.status} />
      </header>

      {registration.status === 'QUEUED' && (
        <p className="status-line">
          Queued at position{' '}
          <strong className="big-number">{registration.queuePosition ?? '?'}</strong>
          {mode === 'PER_SESSION'
            ? ` for ${sessionTitle(sessions, registration.acceptable[0])}`
            : ''}
          .{' '}
          <span className="muted">
            You will be offered a seat as soon as one is free in a session you accept.
          </span>
        </p>
      )}

      {registration.status === 'OFFERED' && offer !== undefined && (
        <div className="status-line">
          <p>
            A seat in <strong>{offeredSession?.title ?? 'a session'}</strong>
            {offeredSession !== undefined ? ` (${formatDateTime(offeredSession.startsAt)})` : ''} is
            held for you.
          </p>
          <p className="countdown-line">
            Confirm within <Countdown expiresAt={offer.expiresAt} onExpire={onChanged} />{' '}
            <span className="muted">(until {formatDateTime(offer.expiresAt)})</span>
          </p>
        </div>
      )}

      {registration.status === 'CONFIRMED' && (
        <p className="status-line">
          Seat confirmed in{' '}
          <strong>{sessionTitle(sessions, registration.confirmedSessionId)}</strong>
          {(() => {
            const session = sessions.find((s) => s.id === registration.confirmedSessionId);
            return session === undefined ? null : (
              <span className="muted"> · starts {formatDateTime(session.startsAt)}</span>
            );
          })()}
        </p>
      )}

      {registration.status === 'ENDED' && (
        <p className="status-line">
          Ended:{' '}
          {registration.endReason === undefined
            ? 'no seat could be allocated'
            : END_REASON_TEXT[registration.endReason]}
          .
        </p>
      )}

      {registration.status === 'CANCELLED' && (
        <p className="status-line">You cancelled this registration.</p>
      )}

      {!compact && registration.acceptable.length > 0 && registration.status !== 'CANCELLED' && (
        <p className="muted small">
          Preference order:{' '}
          {registration.acceptable
            .map((id, i) => `${i + 1}. ${sessionTitle(sessions, id)}`)
            .join(' · ')}
        </p>
      )}

      {(registration.status === 'OFFERED' ||
        registration.status === 'QUEUED' ||
        registration.status === 'CONFIRMED') &&
        !workshopClosed && (
          <div className="actions">
            {registration.status === 'OFFERED' && offer !== undefined && (
              <>
                <AsyncButton
                  state={stateOf(phase, active === 'accept')}
                  idle="Accept seat"
                  pending="Accepting…"
                  done="Accepted"
                  error="Retry accept"
                  onClick={() =>
                    active === 'accept' && phase === 'error' ? void command.retry() : act('accept')
                  }
                  disabled={command.busy}
                />
                <AsyncButton
                  variant="secondary"
                  state={stateOf(phase, active === 'decline')}
                  idle="Decline"
                  pending="Declining…"
                  done="Declined"
                  error="Retry decline"
                  onClick={() =>
                    active === 'decline' && phase === 'error'
                      ? void command.retry()
                      : act('decline')
                  }
                  disabled={command.busy}
                />
              </>
            )}
            {!confirmCancel ? (
              <AsyncButton
                variant="danger"
                state={stateOf(phase, active === 'cancel')}
                idle={
                  registration.status === 'CONFIRMED' ? 'Cancel my seat' : 'Cancel registration'
                }
                pending="Cancelling…"
                done="Cancelled"
                error="Retry cancel"
                onClick={() =>
                  active === 'cancel' && phase === 'error'
                    ? void command.retry()
                    : setConfirmCancel(true)
                }
                disabled={command.busy}
              />
            ) : (
              <span className="confirm-inline">
                Release your {registration.status === 'CONFIRMED' ? 'seat' : 'place'}?{' '}
                <button
                  type="button"
                  className="btn btn-danger btn-small"
                  onClick={() => act('cancel')}
                >
                  Yes, cancel
                </button>{' '}
                <button
                  type="button"
                  className="btn btn-secondary btn-small"
                  onClick={() => setConfirmCancel(false)}
                >
                  Keep it
                </button>
              </span>
            )}
          </div>
        )}

      {processing && (
        <p className="muted small" role="status">
          {slow
            ? 'Still processing — the server has your request; we keep checking every 5 s.'
            : 'Request received, waiting for the outcome…'}
        </p>
      )}
      {command.state.phase === 'error' && (
        <p className="error-text small" role="alert">
          {describeError(command.state.error)}
        </p>
      )}
      {command.state.phase === 'rejected' && (
        <p className="error-text small" role="alert">
          Rejected — see the notification above. The view below reflects the current state.
        </p>
      )}
    </section>
  );
}
