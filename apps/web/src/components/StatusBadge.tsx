import type {
  CommandStatus,
  RegistrationStatus,
  SessionStatus,
  WorkshopStatus,
} from '@seatrelay/contracts';

type AnyStatus = WorkshopStatus | SessionStatus | RegistrationStatus | CommandStatus;

const LABEL: Record<AnyStatus, string> = {
  OPEN: 'Open',
  CLOSED: 'Closed',
  CANCELLING: 'Cancelling…',
  CANCELLED: 'Cancelled',
  QUEUED: 'Queued',
  OFFERED: 'Offered',
  CONFIRMED: 'Confirmed',
  ENDED: 'Ended',
  ACCEPTED: 'Processing',
  APPLIED: 'Applied',
  REJECTED: 'Rejected',
};

/** Colour-coded status pill; `CANCELLING` is the transient drain state (treated as cancelled). */
export function StatusBadge({ status }: { status: AnyStatus }) {
  return (
    <span
      className={`badge badge-${status.toLowerCase()}`}
      title={
        status === 'CANCELLING' ? 'Cancellation in progress; seats are being released' : undefined
      }
    >
      {LABEL[status]}
    </span>
  );
}

/** CANCELLING is treated like CANCELLED for every action (plan note). */
export function isCancelledLike(status: WorkshopStatus | SessionStatus): boolean {
  return status === 'CANCELLING' || status === 'CANCELLED';
}
