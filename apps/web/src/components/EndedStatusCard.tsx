import type { SessionView, WorkshopMode } from '@seatrelay/contracts';
import { describeEnding, REGISTER_AGAIN_TEXT, type ListedRegistration } from '../commands/copy';
import { StatusBadge } from './StatusBadge';

interface Props {
  sessions: readonly SessionView[];
  /** The workshop's mode: PER_SESSION endings are about one session's registration. */
  mode: WorkshopMode;
  /** A CANCELLED/ENDED registration from `GET /me/registrations`. */
  registration: ListedRegistration;
  /** Shown as "Register again" when registration is open and a session can still be joined. */
  onRegisterAgain?: () => void;
  title?: string;
  /** Server time in ms (tests); defaults to `serverNow()`. */
  now?: number;
}

/**
 * Persistent status card for a registration that has ended while the page was open (or before
 * it was opened): what happened in plain words, when, and whether the participant can register
 * again. It replaces the silent return of the empty registration form (browser walkthrough).
 */
export function EndedStatusCard({
  sessions,
  mode,
  registration,
  onRegisterAgain,
  title = 'My status',
  now,
}: Props) {
  const copy = describeEnding(registration, sessions, now, mode);
  return (
    <section
      className={`card status-card status-${registration.status.toLowerCase()}`}
      aria-live="polite"
      aria-labelledby="ended-status-heading"
    >
      <header className="card-header">
        <h2 id="ended-status-heading">{title}</h2>
        <StatusBadge status={registration.status} />
      </header>
      <p className="status-line">{copy.detail}</p>
      {onRegisterAgain !== undefined && (
        <>
          <p className="muted">{REGISTER_AGAIN_TEXT}</p>
          <div className="actions">
            <button type="button" className="btn btn-primary" onClick={onRegisterAgain}>
              Register again
            </button>
          </div>
        </>
      )}
    </section>
  );
}
