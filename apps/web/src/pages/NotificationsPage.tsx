import type { NotificationView } from '@seatrelay/contracts';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMarkNotificationRead, useNotifications } from '../api/queries';
import { RequireAuth } from '../auth/RequireAuth';
import { AsyncButton, type AsyncState } from '../components/AsyncButton';
import { EmptyState } from '../components/EmptyState';
import { ErrorBanner } from '../components/ErrorBanner';
import { Icon, type IconName } from '../components/Icon';
import { Loading } from '../components/Loading';
import { describeError } from '../util/errors';
import { formatDateTime } from '../util/time';
import { useDocumentTitle } from '../util/useDocumentTitle';

const KIND_TEXT: Record<NotificationView['kind'], string> = {
  OFFER: 'Seat offered',
  CONFIRMED: 'Seat confirmed',
  EXPIRED: 'Offer expired',
  DECLINED: 'Offer declined',
  REVOKED: 'Offer revoked',
  SESSION_CANCELLED: 'Session cancelled',
  WORKSHOP_CANCELLED: 'Workshop cancelled',
  ENDED: 'Registration ended',
};

function kindIcon(kind: NotificationView['kind']): IconName {
  switch (kind) {
    case 'OFFER':
      return 'clock';
    case 'CONFIRMED':
      return 'check';
    case 'SESSION_CANCELLED':
    case 'WORKSHOP_CANCELLED':
    case 'DECLINED':
    case 'REVOKED':
    case 'ENDED':
      return 'x';
    default:
      return 'clock';
  }
}

function NotificationRow({ notification }: { notification: NotificationView }) {
  const markRead = useMarkNotificationRead();
  const [state, setState] = useState<AsyncState>('idle');
  const unread = notification.readAt === undefined;
  const mark = async () => {
    setState('pending');
    try {
      await markRead.mutateAsync(notification.id);
      setState('done');
    } catch {
      setState('error');
    }
  };
  return (
    <li
      className={`card notification${unread ? ' notification-unread' : ''} notification-kind-${notification.kind.toLowerCase()}`}
    >
      <div className="card-header">
        <span className="notification-icon" aria-hidden="true">
          <Icon name={kindIcon(notification.kind)} />
        </span>
        <h3>
          {unread && <span className="sr-only">Unread: </span>}
          {notification.title}
        </h3>
        <span className="muted small">
          {KIND_TEXT[notification.kind]} · {formatDateTime(notification.createdAt)}
        </span>
      </div>
      <p className="notification-body">{notification.body}</p>
      <div className="actions">
        <Link
          to={`/workshops/${encodeURIComponent(notification.workshopId)}`}
          className="btn btn-secondary btn-small"
        >
          Open workshop
        </Link>
        {unread && (
          <AsyncButton
            state={state}
            idle="Mark read"
            pending="Marking…"
            done="Read"
            error="Retry"
            variant="secondary"
            className="btn-small"
            onClick={() => void mark()}
          />
        )}
        {state === 'error' && (
          <span className="error-text small" role="alert">
            {describeError(markRead.error)}
          </span>
        )}
        <span className="notification-email">email: {notification.status.toLowerCase()}</span>
      </div>
    </li>
  );
}

function NotificationsList() {
  const query = useNotifications();
  if (query.isPending) {
    return <Loading label="Loading notifications…" />;
  }
  if (query.isError) {
    return (
      <ErrorBanner
        error={query.error}
        title="Could not load notifications"
        onRetry={() => void query.refetch()}
      />
    );
  }
  const items = query.data.notifications;
  if (items.length === 0) {
    return (
      <EmptyState>
        No notifications yet. Offers, confirmations and cancellations will show up here.
      </EmptyState>
    );
  }
  return (
    <ul className="stack list-plain">
      {items.map((notification) => (
        <NotificationRow key={notification.id} notification={notification} />
      ))}
    </ul>
  );
}

export function NotificationsPage() {
  useDocumentTitle('Notifications');
  return (
    <div className="stack">
      <h1>Notifications</h1>
      <RequireAuth purpose="Sign in to see your notifications.">
        <NotificationsList />
      </RequireAuth>
    </div>
  );
}
